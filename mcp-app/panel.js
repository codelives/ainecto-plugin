// The AiNecto panel's screen (KAN-369): notifications, comments you can reply to, and your kanban work.
// The data rules are the Claude Code pane's own (../plugins/ainecto-panel/hooks/inbox.js), so every pane shows
// the same thing; this file only draws, reads on a timer and runs the buttons. It does not know its host:
// the caller passes one (startPanel), which reaches the AiNecto MCP server with the user's own connection.
//   mcp-app/main.js      MCP Apps hosts (ChatGPT, the Codex app, Claude conversations) — mcp-app/dist/ainecto-panel.html
//   mcp-app/artifact.js  a Claude artifact beside the conversation — mcp-app/dist/ainecto-panel-artifact.html
//
// host: { connect({ showToolResult, stop }) → Promise<string> (host name; rejects when it cannot connect),
//         callTool(name, args) → Promise<MCP tools/call result> (rejects on failure; err.retryable === false
//         means repeating it alone cannot succeed), openLink?(url), askAi?(row) }
//   Without openLink a link is a plain <a target=_blank>; without askAi there is no «AI에게» button.
//
// Reading rules (the same as the Claude Code pane — see register.js):
// - The numbers come from get_my_work_summary every POLL_MS, and only while the panel is visible.
// - list_notifications is read only when the unread number changed (or a backlog page waits), and the
//   panel waits out retryAfterSeconds: that tool's 30-second limit is shared with the agent on the same
//   connection (the host calls our server with the same connection the conversation's AI uses).
// - The panel never sends `ack` and never uses `latest`; it reads on from its own nextCursor.
// - Writes happen only when the user presses a button: mark_notifications_read and create_comments.
// Nothing is stored in the browser: the server is the truth, a reopened panel reads it again.
import {
  applyRead,
  buildTabs,
  listArgs,
  mergeNotifications,
  mutationId,
  parseToolResult,
  POLL_MS,
  QUICK_RETRY_MAX,
  QUICK_RETRY_MS,
  readItems,
  replyTarget,
  shouldFetchList,
  summaryView,
  threadRoot,
} from '../plugins/ainecto-panel/hooks/inbox.js';
/**
 * Every AiNecto tool this panel calls. A Claude artifact must name exactly these in its `mcp` manifest
 * (test/mcp-app.test.mjs checks the list against the calls below).
 */
export const PANEL_TOOLS = ['get_my_work_summary', 'list_notifications', 'mark_notifications_read', 'list_comments', 'create_comments'];

const TABS = [
  ['notifications', '알림'],
  ['comments', '댓글'],
  ['work', '업무'],
];

// Panel state. Lost when the host tears the panel down; the next open reads the server again.
let view = null;
let notifications = [];
let cursor = null;
let hasMore = false;
let lastUnread = null;
let retryAt = 0;
let lastSyncAt = null;
let error = null;
let busy = false;
let tab = 'notifications';
let replying = null;
let quickRetries = 0;
let callSeq = 0;
let hostName = '';
let stopped = false;
let notice = '';
let noticeTimer = null;
let host = null;

const $ = (id) => document.getElementById(id);

// ── The one place this panel talks to AiNecto: every call writes a request line and a response line ──
async function callTool(name, args) {
  const id = ++callSeq;
  const started = Date.now();
  console.info(`[ainecto-panel] → #${id} ${name} args=${Object.keys(args ?? {}).join(',')}`);
  let parsed;
  try {
    parsed = parseToolResult(await host.callTool(name, args ?? {}));
  } catch (err) {
    parsed = { ok: false, error: String(err?.message ?? err), retryable: err?.retryable };
  }
  console.info(`[ainecto-panel] ← #${id} ${name} ${parsed.ok ? 'ok' : 'error: ' + parsed.error} ${Date.now() - started}ms`);
  return parsed;
}

function retrySoon() {
  if (stopped || quickRetries >= QUICK_RETRY_MAX) return;
  quickRetries += 1;
  setTimeout(() => poll(), QUICK_RETRY_MS);
}

async function fetchList() {
  const r = await callTool('list_notifications', listArgs(cursor));
  if (!r.ok) return;
  const data = r.data ?? {};
  if (data.retryAfterSeconds) {
    retryAt = Date.now() + Number(data.retryAfterSeconds) * 1000;
    return;
  }
  notifications = mergeNotifications(notifications, data.items).items;
  if (data.nextCursor) cursor = data.nextCursor;
  hasMore = Boolean(data.hasMore);
  lastUnread = view ? view.unread : null;
}

function useSummary(data) {
  view = summaryView(data);
  error = null;
  quickRetries = 0;
  lastSyncAt = Date.now();
}

async function poll() {
  if (busy || stopped) return;
  busy = true;
  try {
    const r = await callTool('get_my_work_summary', {});
    if (!r.ok) {
      error = '동기화 실패' + (r.retryable === false ? ': ' + r.error : '');
      if (r.retryable !== false) retrySoon();
      return;
    }
    useSummary(r.data);
    if (shouldFetchList({ unread: view.unread, lastUnread, hasMore, now: Date.now(), retryAt })) await fetchList();
  } finally {
    busy = false;
    render();
  }
}

/** The timer's tick: read only while the panel is shown. */
function tick() {
  if (document.visibilityState === 'hidden') return;
  poll();
}

async function markRead(row) {
  const items = readItems([row.item]);
  if (!items.length) return;
  const r = await callTool('mark_notifications_read', { items });
  if (!r.ok) {
    flash('읽음 처리 실패: ' + r.error);
    return;
  }
  notifications = applyRead(notifications, r.data?.results);
  if (view) view = { ...view, mentions: applyRead(view.mentions, r.data?.results) };
  render();
  await poll();
}

async function sendReply(row, text) {
  const body = String(text ?? '').trim();
  const target = replyTarget(row.item);
  if (!body || !target) return;
  const parent = target.cardUuid ? { cardUuid: target.cardUuid } : { documentUuid: target.documentUuid };
  // Replies are one level deep: answer under the thread's top-level comment.
  const listed = await callTool('list_comments', parent);
  const root = listed.ok ? threadRoot(listed.data?.comments, target.commentId) : null;
  if (!root) {
    flash('원래 댓글을 찾지 못했습니다' + (listed.ok ? '' : ': ' + listed.error));
    return;
  }
  const r = await callTool('create_comments', {
    ...parent,
    items: [{ body, parentCommentId: root, clientMutationId: mutationId(row.id, body) }],
  });
  const result = r.ok ? r.data?.results?.[0] : null;
  if (!result?.ok) {
    flash('답글 실패: ' + (result?.error ?? r.error ?? 'unknown'));
    return;
  }
  replying = null;
  renderReply();
  flash('답글을 달았습니다');
}

async function askAi(row) {
  try {
    await host.askAi(row);
    flash('대화창에 보냈습니다');
  } catch (err) {
    flash('대화창에 보내지 못했습니다: ' + (err?.message ?? err));
  }
}

// ── Drawing ──

function flash(text) {
  notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = '';
    renderHead();
  }, QUICK_RETRY_MS);
  renderHead();
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'onClick') {
      if (v) node.addEventListener('click', v);
    }
    else if (k === 'className') node.className = v;
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function clock(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function renderHead() {
  const head = $('head');
  if (error) {
    head.className = 'head error';
    head.textContent = '⚠ ' + error;
  } else {
    head.className = 'head';
    head.textContent =
      (view ? '● 연결됨' : '○ 연결 중') +
      ' · ' + clock(lastSyncAt) + ' 동기화' +
      (view ? ' · 안 읽음 ' + view.unread + (view.unreadCapped ? '+' : '') : '');
  }
  $('notice').textContent = notice;
  $('notice').hidden = !notice;
}

function renderReply() {
  const box = $('reply');
  box.hidden = !replying;
  if (!replying) return;
  $('reply-target').textContent = '↳ ' + replying.title;
  const input = $('reply-input');
  input.value = '';
  input.focus();
}

function rowView(row) {
  const buttons = [];
  if (row.url) {
    const onClick = host.openLink
      ? (event) => {
          event.preventDefault();
          host.openLink(row.url);
        }
      : undefined;
    buttons.push(el('a', { className: 'link', href: row.url, target: '_blank', rel: 'noopener', onClick }, '열기'));
  }
  if (row.actions.includes('read')) buttons.push(el('button', { className: 'link', onClick: () => markRead(row) }, '확인'));
  if (row.actions.includes('reply')) {
    buttons.push(
      el('button', {
        className: 'link',
        onClick: () => {
          replying = row;
          renderReply();
        },
      }, '답하기'),
    );
  }
  if (host.askAi && (row.item?.target || row.url)) {
    buttons.push(el('button', { className: 'link', onClick: () => askAi(row) }, 'AI에게'));
  }
  return el('li', { className: row.unread ? 'row unread' : 'row' }, [
    el('div', { className: 'title' }, (row.unread ? '● ' : '○ ') + row.title),
    el('div', { className: 'meta' }, [el('span', { className: 'detail' }, row.detail || ' '), ...buttons]),
  ]);
}

function render() {
  renderHead();
  const tabs = buildTabs({ view, notifications });
  const counts = {
    notifications: view ? view.unread : 0,
    comments: tabs.comments.filter((r) => r.unread).length,
    work: view ? view.cardCounts.assignedOpen : 0,
  };
  $('tabs').replaceChildren(
    ...TABS.map(([id, label]) =>
      el('button', {
        className: tab === id ? 'tab active' : 'tab',
        'aria-pressed': tab === id ? 'true' : 'false',
        onClick: () => {
          tab = id;
          replying = null;
          renderReply();
          render();
        },
      }, `${label} ${counts[id]}`),
    ),
    el('button', { className: 'tab sync', onClick: () => poll() }, '동기화'),
  );
  const workHead = $('work-head');
  workHead.hidden = !(tab === 'work' && view);
  if (tab === 'work' && view) {
    const c = view.cardCounts;
    workHead.textContent = `수락 대기 ${c.pendingAcceptance} · 진행 ${c.inProgress} · 검토 ${c.inReview} · 막힘 ${c.blocked}`;
  }
  const rows = tabs[tab] ?? [];
  $('rows').replaceChildren(
    ...(rows.length ? rows.map(rowView) : [el('li', { className: 'empty' }, view ? '표시할 항목이 없습니다' : '불러오는 중…')]),
  );
  $('foot').textContent = hostName ? `AiNecto 패널 · ${hostName}` : 'AiNecto 패널';
}

// ── Start ──

function wire() {
  // No <form>: hosts sandbox the panel without allow-forms, and a blocked form never fires submit.
  const send = () => {
    if (replying) sendReply(replying, $('reply-input').value);
  };
  $('reply-send').addEventListener('click', send);
  $('reply-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });
  $('reply-cancel').addEventListener('click', () => {
    replying = null;
    renderReply();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!lastSyncAt || Date.now() - lastSyncAt >= POLL_MS)) poll();
  });

}

/** A tool result the host already has (the tool that opened the panel returns get_my_work_summary's body). */
function showToolResult(result) {
  const parsed = parseToolResult(result);
  if (parsed.ok && parsed.data && typeof parsed.data === 'object' && 'notifications' in parsed.data) {
    useSummary(parsed.data);
    render();
  }
}

/** Draws the panel and starts reading through `host` (see the top of this file). */
export async function startPanel(theHost) {
  host = theHost;
  wire();
  render();
  try {
    hostName = (await host.connect({ showToolResult, stop: () => (stopped = true) })) ?? '';
  } catch (err) {
    error = '호스트 연결 실패: ' + (err?.message ?? err);
    render();
    return;
  }
  render();
  setInterval(tick, POLL_MS);
  poll();
}
