// The panel's host inside a Claude artifact (opened beside the conversation in Claude web and desktop). Everything
// comes from the artifact runtime's capabilities (`claude.use(name)`), so the panel keeps no timer or store of its own:
//   mcp          the viewer's own claude.ai AiNecto connector: watchTool keeps reads current (about every 30 s,
//                paused while hidden, caught up on return), invalidate re-reads now, callTool runs the writes
//   comments     «AI에게» first: comments.sendToClaude posts the item as a short comment on this artifact and sends
//                it to the publisher's Claude (each person publishes their own panel, so that is the viewer's own
//                Claude) — one click, no dialog (KAN-392). customAnchors keeps the buttons working in comment mode.
//   room         everyone with this artifact open: a signal {c, s, k} after a message is stored, «입력 중» presence,
//                and sendToClaudeSession — «AI에게» where comments cannot send (KAN-388's dialog)
//   user         names for the people typing (presence carries ids only)
//   permissions  the «권한 설정 열기» button
// Which connector it calls is the artifact's published manifest, not this file: the host takes the manifest server
// that has PROBE_TOOL. No DOM here, so node --test runs it with a fake `claude`.
import { contextText, POLL_MS, PROBE_TOOL, SIGNAL_TOPIC } from '../plugins/ainecto-panel/hooks/inbox.js';

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

/** canSendToClaudeSession answers that let «AI에게» through. Each takes a {deliver: 'send'}; where one cannot ask
 *  the viewer (a browser that cannot prove the click, or the platform has it off) it is `claude_unavailable` and the
 *  same press stages instead (room.d.ts CanSendToClaudeSession). */
const SENDABLE = new Set(['available', 'available_if_opened', 'available_if_summoned']);

/** Why «AI에게» is hidden, for the other answers (an unknown one or a rejection: the fallback line). */
const HIDDEN = {
  no_session: 'AI에게 버튼은 이 패널을 Claude 대화 옆에 열었을 때 나타납니다',
  unsupported: '이 브라우저에서는 AI에게 보내기를 쓸 수 없습니다',
  off: '이 화면에서는 AI에게 보내기가 꺼져 있습니다',
};

/** comments.canSendToClaude answers without room to fall back on (comments.d.ts CanSendToClaude). */
const HIDDEN_COMMENTS = {
  writers_only: 'AI에게 버튼은 이 패널을 게시한 사람(편집자)만 쓸 수 있습니다 — 내 계정으로 패널을 게시해 여세요',
  no_session: HIDDEN.no_session,
  off: HIDDEN.off,
  forbidden: '이 화면에서는 패널에서 AI에게 보내기(댓글)가 꺼져 있습니다 — Claude 의 댓글 패널에서 다시 허용할 수 있습니다',
};

/** comments rejections after which this view sends through room instead (comments.d.ts CommentsErrorCode):
 *  `claude_unavailable` is decided before anything is written; the lifecycle codes mean the verb is not here. */
const VIA_ROOM = new Set(['claude_unavailable', 'not_granted', 'capability_disabled', 'capability_removed', 'forbidden']);
/** …and of those, the ones that are permanent for this view: comments is not asked again. */
const COMMENTS_GONE = new Set(['not_granted', 'capability_disabled', 'capability_removed', 'forbidden']);

/** The panel's room calls over the runtime's `room` (and `user` for names). Never throws. */
export function roomBridge(room, user, log = () => {}) {
  const quiet = (p) => Promise.resolve(p).catch((err) => log(`room: ${err?.code ?? ''} ${err?.message ?? err}`));
  return {
    emit: (data) => quiet(room.emit(SIGNAL_TOPIC, data)),
    on: (fn) => room.on(SIGNAL_TOPIC, (msg) => fn(msg?.data), (e) => log(`room listener ended: ${e.code}`)),
    onConnection: (fn) => room.onConnection(fn),
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
 * @param {{ projectUuid?: string | null, version?: string | null }} [options] the project this artifact was published
 *   for, and the page's own version (its build's version slot) — the panel compares it with the newest (KAN-404)
 * @returns the host startPanel takes (links stay plain <a>: the artifact opens them in a new tab)
 */
export function createArtifactHost(claude, { projectUuid = null, version = null } = {}) {
  let mcp = null;
  let server = null;
  let room = null;
  let comments = null; // null once it cannot send here (absent, or a permanent refusal) — «AI에게» goes through room
  let via = null; // 'comments' | 'room': where the last canSendToClaude found «AI에게» can go
  const modeListeners = new Set();
  let commentMode = false;
  let anchors = null; // the customAnchors controller, once registered
  const warn = (line) => console.warn(`[ainecto-panel] ${line}`);
  let goneCode = null; // why comments stopped for this view
  const commentsGone = (code) => {
    if (!COMMENTS_GONE.has(code) || !comments) return;
    warn(`comments: ${code} — «AI에게» sends through room from now on`);
    comments = null;
    goneCode = code;
  };

  /** room's send→stage (KAN-388), the same click: 'sent' | 'staged'. */
  const sendByRoom = (ctx) =>
    room.sendToClaudeSession(ctx, { deliver: 'send' }).then(
      () => 'sent',
      (err) => {
        if (err?.code !== 'claude_unavailable') throw err;
        warn(`sendToClaudeSession send: claude_unavailable ${err?.message ?? ''} — staging instead`);
        return room.sendToClaudeSession(ctx, { deliver: 'stage' }).then(() => 'staged');
      },
    );

  /** comments.sendToClaude at the pressed element: a new thread with the short text. 'commented'. */
  const sendByComment = async (ctx, target) => {
    const anchor = await comments.anchorFor(target);
    const r = await comments.sendToClaude({ anchor, text: contextText(ctx) });
    console.info(`[ainecto-panel] comments.sendToClaude: thread ${r?.threadId ?? '?'}`);
    return 'commented';
  };

  /** Comment mode on the artifact: pins stay in the shell's list (placed({})), clicks reach the panel's buttons. */
  const registerAnchors = (c) => {
    if (typeof c.customAnchors !== 'function') return;
    const setMode = (on) => {
      commentMode = on === true;
      for (const fn of modeListeners) fn(commentMode);
    };
    c.customAnchors({ mode: setMode, threads: () => anchors?.placed({}), reveal: () => {} }).then(
      (ctl) => {
        anchors = ctl;
        ctl.placed({}); // the thread list can arrive before this promise settles
      },
      (err) => warn(`comments.customAnchors: ${err?.code ?? ''} ${err?.message ?? err} — comment mode keeps the shell's anchoring`),
    );
  };

  const host = {
    async connect() {
      if (typeof claude?.use !== 'function') throw new Error('Claude 아티팩트 안에서 열어야 합니다');
      const [m, r, u, p, c] = await Promise.all(['mcp', 'room', 'user', 'permissions', 'comments'].map((n) => claude.use(n).catch(() => null)));
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
        host.room = roomBridge(r, u, warn);
      }
      if (c) {
        comments = c;
        registerAnchors(c);
        host.onCommentMode = (fn) => {
          modeListeners.add(fn);
          fn(commentMode);
          return () => modeListeners.delete(fn);
        };
        host.exitCommentMode = () => anchors?.exitMode();
      }
      if (room || comments) {
        // One button, tried in order: comments (one click) → room (KAN-388's send→stage).
        host.canSendToClaude = async () => {
          let state = goneCode;
          if (comments) {
            state = await comments.canSendToClaude().catch((err) => {
              commentsGone(err?.code);
              return `rejected ${err?.code ?? err?.message ?? err}`;
            });
            console.info(`[ainecto-panel] comments.canSendToClaude: ${state}`);
            if (state === 'available') {
              via = 'comments';
              return { ok: true, why: null };
            }
          }
          if (!room) {
            via = null;
            return { ok: false, why: HIDDEN_COMMENTS[state] ?? `AI에게 보내기를 지금 쓸 수 없습니다 (${state})` };
          }
          state = await room.canSendToClaudeSession().catch((err) => `rejected ${err?.code ?? err?.message ?? err}`);
          console.info(`[ainecto-panel] canSendToClaudeSession: ${state}`);
          via = SENDABLE.has(state) ? 'room' : null;
          if (via) return { ok: true, why: null };
          return { ok: false, why: HIDDEN[state] ?? `AI에게 보내기를 지금 쓸 수 없습니다 (${state})` };
        };
        // Called from the click itself (`target` = the pressed item), nothing awaited first: the runtime proves the
        // gesture from it. comments → 'commented'; where comments cannot send (VIA_ROOM — nothing was posted) the
        // same press goes through room → 'sent' | 'staged'. consent_required, rate_limited and the rest reach the
        // panel as they are: a rejected comment write is not proof nothing was posted, so it is never re-sent.
        host.sendToClaude = (ctx, target) => {
          if (via === 'comments' && comments) {
            return sendByComment(ctx, target).catch((err) => {
              commentsGone(err?.code);
              if (!room || !VIA_ROOM.has(err?.code)) throw err;
              warn(`comments.sendToClaude: ${err.code} ${err?.message ?? ''} — sending through room instead`);
              return sendByRoom(ctx);
            });
          }
          if (room) return sendByRoom(ctx);
          return Promise.reject(Object.assign(new Error('no way to reach Claude here'), { code: 'claude_unavailable' }));
        };
      }
      if (p) host.managePermissions = () => p.manage().catch(() => {});
      return { name: `Claude 아티팩트 · ${server}`, projectUuid, version };
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
