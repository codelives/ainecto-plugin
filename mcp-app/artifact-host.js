// The panel's host inside a Claude artifact (opened beside the conversation in Claude web and desktop): the
// artifact runtime's `mcp` capability calls the viewer's own claude.ai connector, with the viewer's
// credentials (`const mcp = await claude.use("mcp")`, then `mcp.callTool(server, tool, input)`).
// Which connector it may call is the artifact's published manifest, not this file: the panel takes the
// manifest server that has PROBE_TOOL. No DOM here, so node --test runs it with a fake `claude`.
import { PROBE_TOOL } from '../plugins/ainecto-panel/hooks/inbox.js';

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

/**
 * @param {{ use?: (name: string) => Promise<any> } | undefined} claude the page's `window.claude`
 * @returns the host startPanel takes (no openLink: links are plain <a>; no askAi: an artifact cannot write
 *   into the conversation)
 */
export function createArtifactHost(claude) {
  let mcp = null;
  let server = null;
  return {
    async connect() {
      if (typeof claude?.use !== 'function') throw new Error('Claude 아티팩트 안에서 열어야 합니다');
      mcp = await claude.use('mcp');
      if (!mcp) throw new Error('이 아티팩트에서는 커넥터를 부를 수 없습니다 (요금제·조직 설정 확인)');
      let listed;
      try {
        listed = await mcp.listTools();
      } catch (err) {
        throw mcpError(err, null);
      }
      server = pickConnector(listed?.servers);
      if (!server) throw new Error('AiNecto 커넥터를 찾지 못했습니다. Claude 설정 › 커넥터에서 연결하세요');
      return `Claude 아티팩트 · ${server}`;
    },
    async callTool(name, args) {
      try {
        return await mcp.callTool(server, name, args);
      } catch (err) {
        throw mcpError(err, server);
      }
    },
  };
}
