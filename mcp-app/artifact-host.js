// The panel's host inside a Claude artifact (opened beside the conversation in Claude web and desktop). Everything
// comes from the artifact runtime's capabilities (`claude.use(name)`), so the panel keeps no timer or store of its own:
//   mcp          the viewer's own claude.ai AiNecto connector: watchTool keeps reads current (about every 30 s,
//                paused while hidden, caught up on return), invalidate re-reads now, callTool runs the writes
//   room         everyone with this artifact open: a signal {c, s, k} after a message is stored, «입력 중» presence,
//                and sendToClaudeSession — «AI에게» hands an item to the viewer's own Claude
//   user         names for the people typing (presence carries ids only)
//   permissions  the «권한 설정 열기» button
// Which connector it calls is the artifact's published manifest, not this file: the host takes the manifest server
// that has PROBE_TOOL. No DOM here, so node --test runs it with a fake `claude`.
import { POLL_MS, PROBE_TOOL, SIGNAL_TOPIC } from '../plugins/ainecto-panel/hooks/inbox.js';

/** What to tell the viewer for an `mcp` rejection code, and the step that fixes it. */
const WHY = {
  needs_reauth: (s) => `${s} 연결이 만료됐습니다. Claude 설정 › 커넥터에서 다시 연결하세요`,
  server_not_connected: (s) => `${s} 커넥터가 연결돼 있지 않습니다. Claude 설정 › 커넥터에서 추가하세요`,
  selection_required: (s) => `같은 이름의 ${s} 커넥터가 여럿입니다. Claude가 띄운 선택 창에서 하나를 고르세요`,
  server_not_found: (s) => `${s} 커넥터가 없어졌습니다. Claude 설정 › 커넥터에서 다시 추가하세요`,
  not_in_manifest: (s) => `이 아티팩트에 ${s}의 이 도구가 허용되지 않았습니다. 아티팩트의 권한 메뉴에서 켜세요`,
  approval_required: (s) =>
    `승인되지 않았습니다. 다시 누르면 승인 창이 뜹니다. ${s} 커넥터의 도구 권한이 «승인 필요»이면 아티팩트에서는 쓸 수 없으니 «항상 허용»으로 바꾸세요`,
  blocked_by_policy: () => '조직 정책이 이 도구를 막았습니다',
  not_granted: () => '이 화면에는 커넥터 호출이 허락되지 않았습니다',
  capability_disabled: () => '이 화면에서는 커넥터 호출을 쓸 수 없습니다',
};

/** An `mcp` rejection as an Error the panel can show; `retryable` only when the runtime stamped it. */
export function mcpError(err, server) {
  const code = err?.code;
  const name = err?.server || server || 'AiNecto';
  const why = WHY[code];
  const text = why ? why(name) : code === 'tool_error' ? String(err?.message ?? 'tool error') : `${code ?? 'error'}: ${err?.message ?? err}`;
  const out = new Error(text);
  out.code = code;
  out.retryable = err?.retryable === true;
  return out;
}

/** The AiNecto connector among listTools() servers: a viewer connector that lists PROBE_TOOL. */
export function pickConnector(servers) {
  const hit = (servers ?? []).find(
    (s) => s && s.kind !== 'artifact' && (s.tools ?? []).some((t) => t && t.name === PROBE_TOOL),
  );
  return hit ? hit.server : null;
}

/** canSendToClaudeSession answers that let «AI에게» through, and how each one delivers. */
const DELIVERY = { available: 'stage', available_if_opened: 'stage', available_if_summoned: 'send' };

/** The panel's room calls over the runtime's `room` (and `user` for names). Never throws. */
export function roomBridge(room, user, log = () => {}) {
  const quiet = (p) => Promise.resolve(p).catch((err) => log(`room: ${err?.code ?? ''} ${err?.message ?? err}`));
  return {
    emit: (data) => quiet(room.emit(SIGNAL_TOPIC, data)),
    on: (fn) => room.on(SIGNAL_TOPIC, (msg) => fn(msg?.data), (e) => log(`room listener ended: ${e.code}`)),
    onReconnect(fn) {
      let was = null;
      return room.onConnection((connected) => {
        if (connected && was === false) fn();
        was = connected;
      });
    },
    presence: (patch) => quiet(room.presence(patch)),
    onPeers: (fn) => room.onPeers((change) => fn(change.peers)),
    async names(ids) {
      if (!user) return {};
      const profiles = await user.profiles(ids);
      return Object.fromEntries(ids.map((id) => [id, profiles?.[id]?.name || '']));
    },
  };
}

/**
 * @param {{ use?: (name: string) => Promise<any> } | undefined} claude the page's `window.claude`
 * @param {{ projectUuid?: string | null }} [options] the project this artifact was published for
 * @returns the host startPanel takes (links stay plain <a>: the artifact opens them in a new tab)
 */
export function createArtifactHost(claude, { projectUuid = null } = {}) {
  let mcp = null;
  let server = null;
  let room = null;
  let delivery = null;
  const host = {
    async connect() {
      if (typeof claude?.use !== 'function') throw new Error('Claude 아티팩트 안에서 열어야 합니다');
      const [m, r, u, p] = await Promise.all(['mcp', 'room', 'user', 'permissions'].map((n) => claude.use(n).catch(() => null)));
      mcp = m;
      if (!mcp) throw new Error('이 아티팩트에서는 커넥터를 부를 수 없습니다 (요금제·조직 설정 확인)');
      let listed;
      try {
        listed = await mcp.listTools();
      } catch (err) {
        throw mcpError(err, null);
      }
      server = pickConnector(listed?.servers);
      if (!server) throw new Error('AiNecto 커넥터를 찾지 못했습니다. Claude 설정 › 커넥터에서 연결하세요');
      if (typeof mcp.watchTool === 'function') {
        host.watch = (name, args, onEvent) =>
          mcp.watchTool(server, name, args, (ev) => onEvent(ev.type === 'error' ? { error: mcpError(ev.error, server) } : { result: ev.result }), {
            refetchInterval: POLL_MS,
          });
        host.refresh = async (name, args) => {
          try {
            await mcp.invalidate(server, name, args);
          } catch {
            // an older shell has no invalidate: a fresh cached call feeds the watch instead
            await mcp.callTool(server, name, args, { cache: { refresh: true } });
          }
        };
      }
      if (r) {
        room = r;
        host.room = roomBridge(r, u, (line) => console.warn(`[ainecto-panel] ${line}`));
        host.canSendToClaude = async () => {
          delivery = DELIVERY[await room.canSendToClaudeSession()] ?? null;
          return Boolean(delivery);
        };
        // Called from the click itself, nothing awaited first: the runtime proves the gesture from this call.
        host.sendToClaude = (ctx) => room.sendToClaudeSession(ctx, { deliver: delivery ?? 'stage' }).then((sent) => sent?.to ?? 'pane');
      }
      if (p) host.managePermissions = () => p.manage().catch(() => {});
      return { name: `Claude 아티팩트 · ${server}`, projectUuid };
    },
    async callTool(name, args) {
      try {
        return await mcp.callTool(server, name, args);
      } catch (err) {
        throw mcpError(err, server);
      }
    },
  };
  return host;
}
