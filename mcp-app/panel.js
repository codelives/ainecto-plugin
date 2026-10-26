// The AiNecto project panel's screen (KAN-368/369, design claude-artifact-chat-design): one AiNecto project's room,
// direct chats between its members, and its notifications as cards. The data rules are the shared pane rules
// (../plugins/ainecto-panel/hooks/inbox.js); this file draws, keeps the reads going and runs the buttons. It does
// not know its host: the caller passes one (startPanel), which reaches AiNecto with the viewer's own connection.
//   mcp-app/main.js      MCP Apps hosts (ChatGPT, the Codex app, Claude conversations) — mcp-app/dist/ainecto-panel.html
//   mcp-app/artifact.js  a Claude artifact beside the conversation — mcp-app/dist/ainecto-panel-artifact.html
//
// host: {
//   connect({ showToolResult, stop }) → Promise<{ name, projectUuid?, version? }>   rejects when it cannot connect;
//                                                  `version` = this page's own version (a Claude artifact: each person
//                                                  publishes a copy, so the panel asks for the newest — KAN-404)
//   callTool(name, args) → Promise<MCP tools/call result>   rejects on failure (err.code, err.retryable)
//   watch?(name, args, onEvent) → unsubscribe     keeps a read current: onEvent({ result }) or onEvent({ error })
//   refresh?(name, args) → Promise                 re-reads a watched call now
//   openLink?(url)                                 without it a link is a plain <a target=_blank>
//   canSendToClaude?() → Promise<{ ok, why }>      whether «AI에게» can go through right now; `why` says why not
//   sendToClaude?(ctx, target) → Promise<'commented'|'sent'|'staged'>  hands contextForClaude(...) to the viewer's AI;
//                                                  called synchronously from the click (the artifact runtime proves the
//                                                  gesture from it); `target` = the pressed item's element
//   onCommentMode?(fn(on)) → unsubscribe           the artifact's comment mode turned on/off (the panel shows «끄기»)
//   exitCommentMode?()                             asks the host to leave comment mode
//   room?: { emit(data), on(fn), onConnection(fn(connected)), presence(patch), onPeers(fn), names(ids) → Promise<{[id]: name}> }
//   managePermissions?()                           opens the host's permission settings
// }
// Without watch the panel reads again every POLL_MS while it is shown (MCP Apps give a panel no live reads).
// While nobody in the room can signal it (no room, not connected, or nobody else has the conversation open —
// readsAlone), the open conversation is also read every ALONE_POLL_MS while shown; an error stops that for good.
//
// Rules this file keeps:
// - The server is the truth for messages. A room signal carries only {conversation, seq} and is sent after the
//   server stored the message; whoever hears it reads again. A pane that learns of a newer message by reading
//   passes the signal on (newerThanKnown), so messages sent from elsewhere (CLI, Claude Code, the web) spread too.
// - Notifications are browsed newest first with order:"newest": the panel never sends `ack` and never moves the
//   agent's saved position.
// - Writes happen only when the viewer presses something: conversation_send, conversation_mark_read (when a
//   conversation is on screen with unread messages), mark_notifications_read.
// - A page that knows its version (host.connect → version) reads open_ainecto_panel once when it opens; when the
//   server names a newer one, «새 버전이 있습니다 · 업데이트» hands the viewer's Claude the republish request.
import {
  ALERT_PAGE,
  ALONE_POLL_MS,
  aloneReadArgs,
  alertCards,
  clockKo,
  contextForClaude,
  conversationsView,
  dayKo,
  holeAfterFill,
  holeAfterRead,
  initialOf,
  MESSAGE_PAGE,
  mergeMessages,
  pendingShown,
  mutationId,
  newerThanKnown,
  PANEL_TABS,
  parseSignal,
  panelUpdate,
  parseToolResult,
  POLL_MS,
  readLabel,
  readThrough,
  readsAlone,
  signalOf,
  tabCounts,
  typingIn,
  updateRequestForClaude,
  whenKo,
} from '../plugins/ainecto-panel/hooks/inbox.js';

/**
 * Every AiNecto tool this panel calls. A Claude artifact must name exactly these in its `mcp` manifest
 * (test/mcp-app.test.mjs checks the list against the calls below).
 */
export const PANEL_TOOLS = [
  'identity_get_self',
  'conversation_list',
  'conversation_get_messages',
  'conversation_send',
  'conversation_mark_read',
  'get_my_work_summary',
  'list_notifications',
  'mark_notifications_read',
  'open_ainecto_panel',
];

// ── State. Lost when the host tears the panel down; the next open reads the server again. ──
let host = null;
let hostName = '';
let stopped = false;
let projectUuid = null;
let me = null; // { userId, displayName }
let conv = conversationsView(null, null);
let unreadAlerts = 0;
let cards = [];
let tab = 'room';
let openChat = null; // a chat's conversationUuid, or { userId, name } for a chat not started yet
let messages = []; // the conversation on screen, oldest first
let page = null; // its last conversation_get_messages answer without the messages
let hole = null; // what of it is not read yet past the messages shown (holeAfterRead): filled page by page, never marked read
let filling = false;
let known = {}; // conversationUuid → highest seq this pane knows (from a read or a signal)
let marking = {}; // conversationUuid → seq a mark_read was sent for
let typingNames = [];
let canAsk = false;
let askWhy = null; // why «AI에게» is hidden, shown where the card's button would be
let banner = null; // { text, error, action?: [label, fn] }
let commentMode = false; // the artifact's comment mode is on (host.onCommentMode)
let syncedAt = null;
let callSeq = 0;
let roomConnected = false;
let roomPeers = [];
let aloneTimer = null;
let aloneOff = false; // a failed read stopped the 5-second reads for this page load (watch reads go on)
let aloneRetried = false;
let aloneBusy = false;
let pending = []; // messages sent from this pane and not yet shown from the server: { id, key, body, state, args, … }
let popoverOpen = false;
let stopMessages = null;
let lastTimelineKey = '';
let ready = false; // identity read: the viewer is known, so the project's reads can start
let pendingProject = null;
let pageVersion = null; // this page's version, when the host knows it (a Claude artifact)
let update = null; // { from, to } once the server named a newer panel (open_ainecto_panel → panel.artifactVersion)
const reads = new Map(); // key → { name, args, read() } for hosts without watch

const $ = (id) => document.getElementById(id);
const keyOf = (name, args) => `${name} ${JSON.stringify(args ?? {})}`;

// ── The one place this panel talks to AiNecto: a request line and a response line for every call ──

async function callTool(name, args) {
  const id = ++callSeq;
  const started = Date.now();
  console.info(`[ainecto-panel] → #${id} ${name} args=${Object.keys(args ?? {}).join(',')}`);
  let parsed;
  try {
    parsed = parseToolResult(await host.callTool(name, args ?? {}));
  } catch (err) {
    parsed = { ok: false, error: String(err?.message ?? err), code: err?.code, retryable: err?.retryable };
  }
  console.info(`[ainecto-panel] ← #${id} ${name} ${parsed.ok ? 'ok' : `error ${parsed.code ?? ''}: ${parsed.error}`} ${Date.now() - started}ms`);
  return parsed;
}

/**
 * Keeps one read current: the host's watch when it has one, else a read now and every POLL_MS while shown.
 * onData(data, storedAt) gets the parsed body; onError(error) a parsed failure. Returns the unsubscribe.
 */
function subscribe(name, args, onData, onError) {
  const deliver = (result, storedAt) => {
    const parsed = parseToolResult(result);
    if (parsed.ok) {
      syncedAt = storedAt ?? Date.now();
      onData(parsed.data);
    } else onError(parsed);
  };
  if (host.watch) {
    const id = ++callSeq;
    console.info(`[ainecto-panel] ⇢ #${id} watch ${name} args=${Object.keys(args ?? {}).join(',')}`);
    return host.watch(name, args, (ev) => {
      if (ev.error) {
        console.info(`[ainecto-panel] ⇠ #${id} ${name} error ${ev.error.code ?? ''}: ${ev.error.message}`);
        onError({ ok: false, error: String(ev.error.message ?? ev.error), code: ev.error.code, retryable: ev.error.retryable });
      } else {
        console.info(`[ainecto-panel] ⇠ #${id} ${name} ok${ev.result?.cache ? ' (cache)' : ''}`);
        deliver(ev.result, ev.result?.cache?.storedAt);
      }
    });
  }
  const key = keyOf(name, args);
  const entry = {
    async read() {
      const r = await callTool(name, args);
      if (reads.get(key) !== entry) return;
      if (r.ok) {
        syncedAt = Date.now();
        onData(r.data);
      } else onError(r);
    },
  };
  reads.set(key, entry);
  entry.read();
  const timer = setInterval(() => {
    if (document.visibilityState !== 'hidden' && !stopped) entry.read();
  }, POLL_MS);
  return () => {
    clearInterval(timer);
    if (reads.get(key) === entry) reads.delete(key);
  };
}

/** Reads a subscribed call again now. */
function refresh(name, args) {
  if (host.watch && host.refresh) return host.refresh(name, args).catch(() => {});
  return reads.get(keyOf(name, args))?.read();
}

const listArgs = () => ({ projectUuid });
const summaryArgs = () => ({ projectUuids: [projectUuid] });
const alertArgs = () => ({ projectUuids: [projectUuid], order: 'newest', limit: ALERT_PAGE });
const messageArgs = (c) => ({ conversationUuid: c, limit: MESSAGE_PAGE });

// ── What is on screen ──

/** The conversation the conversation view shows: the room on the room tab, the open chat on the chat tab. */
function shownConversation() {
  if (tab === 'room') return conv.room;
  if (tab === 'chat' && typeof openChat === 'string') {
    return conv.chats.find((c) => c.conversationUuid === openChat) ?? { conversationUuid: openChat, type: 'DIRECT', name: '' };
  }
  return null;
}

function shownConversationUuid() {
  return shownConversation()?.conversationUuid ?? null;
}

/** Re-points the message read at the conversation on screen. */
function followConversation() {
  const c = shownConversationUuid();
  const key = c ?? '';
  if (key === lastTimelineKey) return;
  lastTimelineKey = key;
  stopMessages?.();
  stopMessages = null;
  messages = [];
  page = null;
  hole = null;
  host.room?.presence({ viewing: c, typingIn: null }).catch?.(() => {});
  updateAloneReads();
  if (!c) return;
  stopMessages = subscribe('conversation_get_messages', messageArgs(c), (data) => useMessages(c, data), (err) => {
    showError(err, '메시지를 읽지 못했습니다');
  });
}

/** Every read of the open conversation lands here: the watch, the reads alone (`after` set), a re-read on a signal. */
async function useMessages(c, data, { after = false } = {}) {
  if (c !== shownConversationUuid()) return;
  const incoming = Array.isArray(data?.messages) ? data.messages : [];
  hole = holeAfterRead(hole, c, messages, incoming, { hasMore: data?.hasMore, after });
  messages = mergeMessages(messages, incoming);
  page = { conversationUuid: c, type: data?.type, latestSeq: data?.latestSeq, myLastReadSeq: data?.myLastReadSeq };
  passOn([{ conversationUuid: c, latestSeq: data?.latestSeq }]);
  clearBanner();
  render();
  await fillHole(c);
  markSeen(c);
}

/**
 * Reads the hole of conversation `c` (see `hole`) page by page while the server says newer ones exist. A failed read
 * leaves the hole: every later read of the conversation tries again, and nothing past it is marked read meanwhile.
 */
async function fillHole(c) {
  if (filling) return;
  filling = true;
  try {
    while (hole?.conversationUuid === c && c === shownConversationUuid()) {
      const r = await callTool('conversation_get_messages', { conversationUuid: c, afterSeq: hole.after, limit: MESSAGE_PAGE });
      if (!r.ok || hole?.conversationUuid !== c || c !== shownConversationUuid()) return;
      messages = mergeMessages(messages, r.data?.messages);
      hole = holeAfterFill(hole, r.data?.messages, r.data?.hasMore);
      render();
    }
  } finally {
    filling = false;
  }
}

// ── Reading alone: nobody in the room will signal this pane ──

function aloneWanted() {
  return (
    !stopped &&
    !aloneOff &&
    Boolean(projectUuid) &&
    document.visibilityState !== 'hidden' &&
    readsAlone({ hasRoom: Boolean(host.room), connected: roomConnected, peers: roomPeers, conversationUuid: shownConversationUuid() })
  );
}

/** Starts or stops the reads alone to match aloneWanted(). */
function updateAloneReads() {
  const wanted = aloneWanted();
  if (wanted && !aloneTimer) {
    aloneTimer = setInterval(readAlone, ALONE_POLL_MS);
    console.info(`[ainecto-panel] reading alone every ${ALONE_POLL_MS}ms`);
  } else if (!wanted && aloneTimer) {
    clearInterval(aloneTimer);
    aloneTimer = null;
    console.info('[ainecto-panel] reading alone stopped');
  }
}

async function readAlone() {
  const c = shownConversationUuid();
  if (!c || !page || aloneBusy || !aloneWanted()) return;
  aloneBusy = true;
  const r = await callTool('conversation_get_messages', aloneReadArgs(c, messages));
  aloneBusy = false;
  if (r.ok) {
    aloneRetried = false;
    useMessages(c, r.data, { after: true });
    return;
  }
  // One more try on the next tick for a retryable failure; anything else (or a second failure, or a rate limit)
  // stops the 5-second reads for this page load — the 30-second watch goes on.
  if (r.retryable && r.code !== 'rate_limited' && !aloneRetried) {
    aloneRetried = true;
    return;
  }
  aloneOff = true;
  console.info(`[ainecto-panel] reading alone off after ${r.code ?? 'error'}`);
  updateAloneReads();
}

/** The viewer sees the conversation: move their read position (and the notifications it covers). */
async function markSeen(c) {
  const through = readThrough(page, hole);
  if (!through || document.visibilityState === 'hidden' || (marking[c] ?? 0) >= through) return;
  marking[c] = through;
  const r = await callTool('conversation_mark_read', { conversationUuid: c, throughSeq: through });
  if (!r.ok) {
    marking[c] = 0;
    return;
  }
  refresh('conversation_list', listArgs());
  refresh('get_my_work_summary', summaryArgs());
}

/** Signals for what this pane read before anyone told it (see newerThanKnown). */
function passOn(conversations) {
  const next = newerThanKnown(known, conversations);
  known = next.known;
  for (const s of next.signals) host.room?.emit(s).catch?.(() => {});
}

function onSignal(data) {
  const s = parseSignal(data);
  if (!s) return;
  const mine = (conv.room && conv.room.conversationUuid === s.c) || conv.chats.some((c) => c.conversationUuid === s.c);
  if (!mine || (known[s.c] ?? 0) >= s.s) return;
  known = { ...known, [s.c]: s.s };
  refresh('conversation_list', listArgs());
  if (s.c === shownConversationUuid()) refresh('conversation_get_messages', messageArgs(s.c));
}

// ── A newer panel (KAN-404) ──

/**
 * Once per open: the newest panel version the server knows, against this page's. Any failure leaves the bar hidden
 * (callTool has logged it) — the panel works the same without the check.
 */
async function checkVersion() {
  if (!pageVersion) return;
  const r = await callTool('open_ainecto_panel', projectUuid ? { projectUuid } : {});
  if (!r.ok) return;
  update = panelUpdate(pageVersion, r.data?.panel?.artifactVersion);
  console.info(`[ainecto-panel] version ${pageVersion}, newest ${r.data?.panel?.artifactVersion ?? '?'}${update ? ' — update offered' : ''}`);
  render();
}

// ── Buttons ──

const DRAFT_PREFIX = 'ainecto-panel:draft:';

function draftKey() {
  if (tab === 'room') return conv.room?.conversationUuid ?? null;
  if (typeof openChat === 'string') return openChat;
  if (openChat?.userId) return `to:${openChat.userId}`;
  return null;
}

function loadDraft(key) {
  try {
    return localStorage.getItem(DRAFT_PREFIX + projectUuid + ':' + key) ?? '';
  } catch {
    return '';
  }
}

function saveDraft(key, text) {
  try {
    if (text) localStorage.setItem(DRAFT_PREFIX + projectUuid + ':' + key, text);
    else localStorage.removeItem(DRAFT_PREFIX + projectUuid + ':' + key);
  } catch {
    // a private window or blocked storage: the draft lives only on screen
  }
}

/**
 * Sends what is typed. The text shows at once as the viewer's own bubble with a spinner and the input empties; when
 * the server has stored it the bubble becomes the stored message, when it fails the bubble offers «다시 보내기»
 * with the same clientMutationId (the server stores a message once per key).
 */
function send() {
  const key = draftKey();
  const input = $('compose-input');
  const body = input.value.trim();
  if (!key || !body) return;
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const target = typeof openChat === 'object' && openChat && tab === 'chat'
    ? { to: { projectUuid, userId: openChat.userId } }
    : { conversationUuid: key };
  const p = {
    id: nonce,
    key,
    body,
    at: new Date().toISOString(),
    afterSeq: messages.reduce((n, m) => Math.max(n, Number(m.seq)), 0),
    state: 'sending',
    error: '',
    args: { ...target, body, clientMutationId: mutationId(`${key}:${nonce}`, body) },
  };
  pending = [...pending, p];
  input.value = '';
  saveDraft(key, '');
  host.room?.presence({ typingIn: null }).catch?.(() => {});
  render();
  $('conv-scroll').scrollTop = $('conv-scroll').scrollHeight;
  deliver(p);
}

async function deliver(p) {
  p.state = 'sending';
  render();
  const r = await callTool('conversation_send', p.args);
  if (!r.ok) {
    p.state = 'failed';
    p.error = sendError(r);
    render();
    return;
  }
  pending = pending.filter((x) => x !== p);
  const sent = r.data ?? {};
  if (sent.conversationUuid && sent.seq) {
    known = { ...known, [sent.conversationUuid]: Math.max(known[sent.conversationUuid] ?? 0, Number(sent.seq)) };
    host.room?.emit(signalOf(sent.conversationUuid, sent.seq)).catch?.(() => {});
  }
  // The stored message replaces the bubble right away; the next read brings the same seq (merged by seq).
  const stored = { seq: sent.seq, uuid: sent.messageUuid, author: { userId: me?.userId, displayName: me?.displayName }, body: p.body, at: sent.at, readCount: 0 };
  const startedChat = p.key.startsWith('to:') && tab === 'chat' && typeof openChat === 'object' && openChat && `to:${openChat.userId}` === p.key;
  if (startedChat && sent.conversationUuid) {
    openChat = sent.conversationUuid;
    followConversation();
    page = { conversationUuid: sent.conversationUuid, type: sent.type, latestSeq: sent.seq, myLastReadSeq: sent.seq };
  }
  if (sent.conversationUuid && sent.conversationUuid === shownConversationUuid() && sent.seq) {
    messages = mergeMessages(messages, [stored]);
  }
  if (sent.conversationUuid) refresh('conversation_get_messages', messageArgs(sent.conversationUuid));
  refresh('conversation_list', listArgs());
  render();
}

function dropPending(p) {
  pending = pending.filter((x) => x !== p);
  render();
}

function sendError(r) {
  if (/RECIPIENT_NOT_PROJECT_MEMBER/.test(r.error)) return '상대가 이 프로젝트 구성원이 아니어서 보낼 수 없습니다';
  if (/403|forbidden|edit rights|permission/i.test(r.error)) return '이 프로젝트에서 메시지를 보낼 권한이 없습니다 (보기 권한은 읽기만)';
  return '보내지 못했습니다';
}

async function markAlertRead(card) {
  const r = await callTool('mark_notifications_read', { items: [{ id: card.id, seq: card.seq }] });
  if (!r.ok) {
    showError(r, '확인 처리하지 못했습니다');
    return;
  }
  refresh('list_notifications', alertArgs());
  refresh('get_my_work_summary', summaryArgs());
}

/** What the viewer reads after «AI에게», by how the host delivered it. */
const ASKED = {
  commented: 'Claude 에게 보냈습니다 — 답은 댓글 스레드에 옵니다',
  sent: 'Claude 에게 보냈습니다 — 확인 창이 뜨면 «보내기»를 누르고 대화를 확인하세요',
  staged: '대화 입력창에 넣었습니다 — 덧붙일 말을 쓰고 보내세요',
};

/** Why «AI에게» did not go through, by rejection code (artifact comments.d.ts / room.d.ts). */
const ASK_FAILED = {
  consent_required: '처음 한 번 댓글 허용이 필요합니다 — 허용 창에서 허용한 뒤 다시 누르세요 (창을 닫았다면 패널을 새로 열고 누르세요)',
  claude_unavailable: '지금 받을 Claude 대화가 없습니다. 이 패널을 Claude 대화 옆에 열고 다시 누르세요',
  rate_limited: '너무 자주 보냈습니다. 잠시 뒤 다시 누르세요',
  forbidden: '이 화면에서는 패널에서 AI에게 보내기(댓글)가 꺼져 있습니다',
};

/** «AI에게»: hands the item to the viewer's own AI. Runs inside the click, before anything is awaited. */
function askAi(ctx, event) {
  const target = event?.currentTarget?.closest?.('article, .card') ?? event?.currentTarget ?? null;
  let sent;
  try {
    sent = host.sendToClaude(ctx, target);
  } catch (err) {
    sent = Promise.reject(err);
  }
  Promise.resolve(sent).then(
    (how) => flash(ASKED[how] ?? ASKED.staged),
    (err) => {
      console.warn(`[ainecto-panel] AI에게 failed: ${err?.code ?? ''} ${err?.message ?? err}`);
      flash(askError(err), true);
      updateCanAsk(); // a permanent refusal (forbidden …) changes what the button does or hides it
    },
  );
}

function askError(err) {
  return ASK_FAILED[err?.code] ?? 'AI에게 보내지 못했습니다: ' + (err?.message ?? err);
}

async function updateCanAsk() {
  const before = [canAsk, askWhy];
  let can = { ok: false, why: null };
  try {
    if (host.sendToClaude) can = host.canSendToClaude ? await host.canSendToClaude() : { ok: true, why: null };
  } catch (err) {
    console.warn(`[ainecto-panel] canSendToClaude failed: ${err?.code ?? ''} ${err?.message ?? err}`);
  }
  canAsk = can.ok;
  askWhy = can.ok ? null : can.why;
  if (askWhy && askWhy !== before[1]) flash(askWhy);
  else if (canAsk !== before[0]) render();
}

// ── Messages for the viewer ──

const WHY_SECTION = {
  not_in_manifest: '이 아티팩트에 이 AiNecto 도구가 허용되지 않았습니다',
  approval_required: '이 도구는 «항상 허용»이어야 패널에서 쓸 수 있습니다 (커넥터 도구 권한)',
};

function showError(r, prefix) {
  const text = `${prefix}: ${r.error}`;
  const fixable = ['not_in_manifest', 'approval_required'].includes(r.code) && host.managePermissions;
  banner = { text: WHY_SECTION[r.code] ? `${prefix} — ${WHY_SECTION[r.code]}` : text, error: true, action: fixable ? ['권한 설정 열기', () => host.managePermissions()] : null };
  render();
}

function clearBanner() {
  if (banner?.error) {
    banner = null;
    render();
  }
}

let flashTimer = null;
function flash(text, error = false) {
  banner = { text, error };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (banner?.text === text) {
      banner = null;
      render();
    }
  }, 6000);
  render();
}

// ── Drawing ──

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'onClick') {
      if (v) node.addEventListener('click', v);
    } else if (k === 'className') node.className = v;
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function link(url, text, className) {
  const onClick = host.openLink
    ? (event) => {
        event.preventDefault();
        host.openLink(url);
      }
    : undefined;
  return el('a', { className, href: url, target: '_blank', rel: 'noopener', onClick }, text);
}

function renderTabs() {
  const counts = tabCounts(conv, { unread: unreadAlerts });
  $('tabs').replaceChildren(
    ...PANEL_TABS.map(([id, label]) =>
      el('button', {
        type: 'button',
        className: tab === id ? 'tab active' : 'tab',
        'aria-current': tab === id ? 'page' : null,
        onClick: () => selectTab(id),
      }, [label, counts[id] ? el('span', { className: id === 'alerts' ? 'badge' : 'badge strong' }, String(counts[id])) : null]),
    ),
  );
}

function selectTab(id) {
  if (tab === id && id === 'chat' && openChat) openChat = null;
  tab = id;
  popoverOpen = false;
  onConversationChange();
}

function onConversationChange() {
  followConversation();
  const key = draftKey();
  $('compose-input').value = key ? loadDraft(key) : '';
  render();
  updateCanAsk();
}

function renderBanner() {
  const b = $('banner');
  b.hidden = !banner;
  if (!banner) return;
  b.className = banner.error ? 'banner error' : 'banner';
  b.replaceChildren(...[el('span', {}, banner.text), banner.action ? el('button', { type: 'button', onClick: banner.action[1] }, banner.action[0]) : null].filter(Boolean));
}

/** «새 버전이 있습니다 · 업데이트» above the tabs; where «AI에게» cannot go, what to tell Claude instead. */
function renderUpdate() {
  const b = $('update');
  b.hidden = !update;
  if (!update) return;
  const ask = canAsk
    ? el('button', { type: 'button', onClick: (event) => askAi(updateRequestForClaude({ projectUuid, ...update }), event) }, '업데이트')
    : el('span', { className: 'update-why' }, '옆 Claude 대화에 «AiNecto 패널을 최신 버전으로 같은 주소에 다시 게시해 줘» 라고 말하세요');
  b.replaceChildren(el('span', {}, '새 버전이 있습니다'), ask);
}

function renderCommentMode() {
  const b = $('comment-mode');
  b.hidden = !commentMode;
  if (!commentMode) return;
  b.replaceChildren(
    el('span', {}, '댓글 모드가 켜져 있습니다'),
    host.exitCommentMode ? el('button', { type: 'button', onClick: () => host.exitCommentMode() }, '끄기') : null,
  );
}

function renderConversation() {
  const view = $('view-conversation');
  const c = shownConversation();
  const draft = tab === 'chat' && openChat && typeof openChat === 'object';
  view.hidden = !(c || draft);
  if (view.hidden) return;
  const direct = draft || c?.type === 'DIRECT';
  const name = draft ? openChat.name : direct ? c.name || '개인 챗' : conv.projectName || c?.name || '프로젝트 룸';
  $('conv-head').replaceChildren(
    ...[direct ? el('button', { type: 'button', className: 'back', 'aria-label': '챗 목록', onClick: () => { openChat = null; onConversationChange(); } }, '‹') : null,
    el('div', { className: 'icon', 'aria-hidden': 'true' }, direct ? initialOf(name) : '#'),
    el('div', { className: 'head-text' }, [
      el('div', { className: 'head-title' }, name),
      el('div', { className: 'head-meta' }, direct ? '개인 챗' : `프로젝트 룸 · 멤버 ${conv.memberCount}명`),
    ]),
  ].filter(Boolean));
  renderTimeline(c, direct, draft);
  $('typing').textContent = typingNames.length ? `${typingNames.join(', ')} 입력 중…` : '';
  const input = $('compose-input');
  input.placeholder = direct ? `${name}님에게 메시지 보내기` : '프로젝트 룸에 메시지 보내기';
  $('compose-send').disabled = !input.value.trim();
}

function renderTimeline(c, direct, draft) {
  const box = $('timeline');
  const scroller = $('conv-scroll');
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  const shown = draft ? [] : messages;
  const waiting = pendingShown(pending.filter((p) => p.key === draftKey()), shown, me?.userId);
  if (!shown.length && !waiting.length) {
    const empty = draft
      ? `${openChat.name}님과의 첫 메시지를 보내면 챗이 시작됩니다`
      : !page ? '불러오는 중…' : direct ? '아직 메시지가 없습니다' : '프로젝트 룸에 첫 메시지를 남겨 보세요';
    box.replaceChildren(el('div', { className: 'empty' }, empty));
    return;
  }
  const now = Date.now();
  const nodes = [];
  let day = '';
  for (const m of [...shown, ...waiting]) {
    const d = dayKo(m.at, now);
    if (d && d !== day) {
      day = d;
      nodes.push(el('div', { className: 'date' }, d));
    }
    nodes.push(m.state ? pendingView(m) : messageView(m, c, direct));
  }
  box.replaceChildren(...nodes);
  if (atBottom || !box.dataset.shown) scroller.scrollTop = scroller.scrollHeight;
  box.dataset.shown = '1';
}

/** A message this pane is sending (spinner) or failed to send («다시 보내기» with the same key). */
function pendingView(p) {
  const failed = p.state === 'failed';
  return el('article', { className: failed ? 'msg mine failed' : 'msg mine sending', 'data-pending': p.id }, el('div', { className: 'msg-body' }, [
    el('div', { className: 'bubble' }, [failed ? null : el('span', { className: 'spinner', role: 'status', 'aria-label': '보내는 중' }), p.body]),
    el('div', { className: 'receipt' }, failed
      ? [
          el('span', { className: 'send-error' }, p.error || '보내지 못했습니다'),
          el('button', { type: 'button', className: 'ask-link retry', onClick: () => deliver(p) }, '다시 보내기'),
          el('button', { type: 'button', className: 'ask-link', onClick: () => dropPending(p) }, '지우기'),
        ]
      : [el('span', {}, '보내는 중')]),
  ]));
}

function messageView(m, c, direct) {
  const mine = me && m.author?.userId === me.userId;
  const author = m.author?.displayName || '탈퇴한 사용자';
  const ask = canAsk && !mine
    ? el('button', { type: 'button', className: 'ask-link', onClick: (event) => askAi(contextForClaude({ projectUuid, message: m, conversation: { conversationUuid: c?.conversationUuid, type: direct ? 'DIRECT' : 'PROJECT_ROOM', name: direct ? c?.name : conv.projectName } }), event) }, 'AI에게')
    : null;
  if (mine) {
    const read = readLabel(m, page?.type, me.userId);
    return el('article', { className: 'msg mine' }, el('div', { className: 'msg-body' }, [
      el('div', { className: 'bubble' }, m.body ?? ''),
      el('div', { className: 'receipt' }, [read ? el('span', { className: 'read' }, read) : null, el('time', {}, clockKo(m.at))]),
    ]));
  }
  return el('article', { className: 'msg' }, [
    el('div', { className: 'avatar', 'aria-hidden': 'true' }, initialOf(author)),
    el('div', { className: 'msg-body' }, [
      el('div', { className: 'sender' }, [author, el('time', {}, clockKo(m.at)), ask]),
      el('div', { className: 'bubble' }, m.body ?? ''),
    ]),
  ]);
}

function renderChats() {
  const view = $('view-chats');
  view.hidden = !(tab === 'chat' && !openChat);
  if (view.hidden) return;
  const now = Date.now();
  const rows = conv.chats.map((c) =>
    el('li', {}, el('button', { type: 'button', className: 'row', onClick: () => { openChat = c.conversationUuid; onConversationChange(); } }, [
      el('div', { className: 'icon', 'aria-hidden': 'true' }, initialOf(c.name)),
      el('div', { className: 'row-text' }, [
        el('div', { className: 'row-top' }, [el('strong', {}, c.name || '이름 없음'), el('time', {}, c.lastMessage ? whenKo(c.lastMessage.at, now) : '')]),
        el('div', { className: 'row-bottom' }, [
          el('span', {}, c.lastMessage ? (c.lastMessage.author?.userId === me?.userId ? '나: ' : '') + (c.lastMessage.preview ?? '') : '메시지 없음'),
          c.unreadCount ? el('span', { className: 'badge strong' }, String(c.unreadCount)) : null,
        ]),
      ]),
    ])),
  );
  $('chat-rows').replaceChildren(...(rows.length ? rows : [el('li', { className: 'empty' }, conv.members.length ? '«＋ 새 챗» 으로 프로젝트 멤버와 챗을 시작하세요' : '이 프로젝트에는 아직 다른 멤버가 없습니다')]));
  $('new-chat').setAttribute('aria-expanded', popoverOpen ? 'true' : 'false');
  $('new-chat-popover').hidden = !popoverOpen;
  if (popoverOpen) renderMembers();
}

function renderMembers() {
  const q = $('member-search').value.trim().toLowerCase();
  const people = conv.members.filter((m) => !q || String(m.displayName ?? '').toLowerCase().includes(q));
  $('member-list').replaceChildren(
    ...(people.length
      ? people.map((m) =>
          el('div', { className: 'person' }, [
            el('div', { className: 'icon', 'aria-hidden': 'true' }, initialOf(m.displayName)),
            el('div', { className: 'person-text' }, [el('strong', {}, m.displayName || '이름 없음'), el('small', {}, m.jobTitle || `${conv.projectName} 멤버`)]),
            el('button', { type: 'button', className: 'chip', onClick: () => startChat(m) }, '챗 시작'),
          ]),
        )
      : [el('div', { className: 'empty' }, conv.members.length ? '찾는 멤버가 없습니다' : '다른 멤버가 없습니다')]),
  );
}

function startChat(member) {
  const existing = conv.chats.find((c) => c.withUserId === member.userId);
  openChat = existing ? existing.conversationUuid : { userId: member.userId, name: member.displayName || '이름 없음' };
  popoverOpen = false;
  onConversationChange();
  $('compose-input').focus();
}

function renderAlerts() {
  const view = $('view-alerts');
  view.hidden = tab !== 'alerts';
  if (view.hidden) return;
  $('alerts-count').textContent = `미확인 ${unreadAlerts}`;
  const now = Date.now();
  $('cards').replaceChildren(
    ...(cards.length
      ? cards.map((card) => cardView(card, now))
      : [el('div', { className: 'empty' }, syncedAt ? '이 프로젝트의 알림이 없습니다' : '불러오는 중…')]),
  );
}

function cardView(card, now) {
  const actions = [];
  if (card.openChat) {
    actions.push(el('button', { type: 'button', className: 'ai-button', onClick: () => { tab = 'chat'; openChat = card.openChat; onConversationChange(); } }, '챗 열기'));
  } else if (card.button && canAsk) {
    actions.push(el('button', { type: 'button', className: 'ai-button', onClick: (event) => askAi(contextForClaude({ projectUuid, card }), event) }, [el('span', { 'aria-hidden': 'true' }, '✧'), card.button, el('span', { 'aria-hidden': 'true' }, '↗')]));
  } else if (card.button && askWhy) {
    actions.push(el('div', { className: 'hint' }, askWhy));
  }
  const links = [];
  if (card.url) links.push(link(card.url, '원문 열기', 'text-link'));
  if (card.unread) links.push(el('button', { type: 'button', className: 'text-link', onClick: () => markAlertRead(card) }, '확인'));
  if (links.length) actions.push(el('div', { className: 'card-links' }, links));
  return el('article', { className: card.unread ? 'card unread' : 'card', 'aria-label': `${card.head} 알림` }, [
    el('div', { className: 'card-head' }, [
      el('span', { className: 'card-mark', 'aria-hidden': 'true' }, card.mark),
      el('span', {}, card.head),
      card.unread ? el('span', { className: 'dot', 'aria-label': '미확인' }) : null,
      el('time', {}, whenKo(card.at, now)),
    ]),
    el('div', { className: 'card-body' }, [
      card.label ? el('div', { className: 'card-label' }, card.label) : null,
      card.title ? el('div', { className: 'card-title' }, card.title) : null,
      card.path ? el('div', { className: 'card-path' }, card.path) : null,
      card.copy ? el('div', { className: 'card-copy' }, card.copy) : null,
      actions.length ? el('div', { className: 'card-actions' }, actions) : null,
    ]),
  ]);
}

function renderFoot() {
  const name = me?.displayName || '';
  $('foot').replaceChildren(
    el('span', { className: 'me', 'aria-hidden': 'true' }, initialOf(name)),
    el('span', {}, name || '연결 중'),
    el('span', { className: 'where' }, [conv.projectName, syncedAt ? `${clockKo(new Date(syncedAt).toISOString())} 동기화` : null].filter(Boolean).join(' · ')),
  );
}

function render() {
  renderUpdate();
  renderTabs();
  renderCommentMode();
  renderBanner();
  renderConversation();
  renderChats();
  renderAlerts();
  renderFoot();
}

// ── Start ──

function wire() {
  const input = $('compose-input');
  // No <form>: hosts sandbox the panel without allow-forms, and a blocked form never fires submit.
  $('compose-send').addEventListener('click', () => send());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });
  input.addEventListener('input', () => {
    const key = draftKey();
    if (key) saveDraft(key, input.value);
    $('compose-send').disabled = !input.value.trim();
    const c = shownConversationUuid();
    if (c) host.room?.presence({ typingIn: input.value.trim() ? c : null }).catch?.(() => {});
  });
  input.addEventListener('blur', () => host.room?.presence({ typingIn: null }).catch?.(() => {}));
  $('new-chat').addEventListener('click', () => {
    popoverOpen = !popoverOpen;
    render();
    if (popoverOpen) $('member-search').focus();
  });
  $('member-search').addEventListener('input', () => renderMembers());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && popoverOpen) {
      popoverOpen = false;
      render();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      updateAloneReads();
      return;
    }
    if (aloneWanted()) readAlone();
    updateAloneReads();
    const c = shownConversationUuid();
    if (c) markSeen(c);
    updateCanAsk();
  });
}

/** A tool result the host already has: the tool that opened the panel names the project (open_ainecto_panel). */
function showToolResult(result) {
  const parsed = parseToolResult(result);
  const uuid = parsed.ok ? parsed.data?.panel?.projectUuid : null;
  if (!uuid || projectUuid) return;
  if (ready) useProject(uuid);
  else pendingProject = uuid;
}

function useProject(uuid) {
  projectUuid = uuid;
  banner = null;
  subscribe('conversation_list', listArgs(), (data) => {
    conv = conversationsView(data, me?.userId);
    passOn(data?.conversations);
    if (tab === 'chat' && typeof openChat === 'object' && openChat) {
      const started = conv.chats.find((c) => c.withUserId === openChat.userId);
      if (started) openChat = started.conversationUuid;
    }
    followConversation();
    render();
  }, (err) => {
    if (/404|not found|403|forbidden/i.test(err.error)) banner = { text: '이 프로젝트를 열 수 없습니다 — 구성원이 아니거나 프로젝트가 없어졌습니다', error: true };
    else showError(err, '대화 목록을 읽지 못했습니다');
    render();
  });
  subscribe('get_my_work_summary', summaryArgs(), (data) => {
    unreadAlerts = Number(data?.notifications?.unread ?? 0);
    render();
  }, (err) => showError(err, '알림 수를 읽지 못했습니다'));
  subscribe('list_notifications', alertArgs(), (data) => {
    cards = alertCards(data?.items);
    render();
  }, (err) => showError(err, '알림을 읽지 못했습니다'));
  const key = draftKey();
  if (key) $('compose-input').value = loadDraft(key);
  render();
}

/** Draws the panel and starts reading through `host` (see the top of this file). */
export async function startPanel(theHost) {
  host = theHost;
  wire();
  render();
  let connected;
  try {
    connected = await host.connect({ showToolResult, stop: () => (stopped = true) });
  } catch (err) {
    banner = { text: '연결하지 못했습니다: ' + (err?.message ?? err), error: true };
    render();
    return;
  }
  hostName = connected?.name ?? '';
  pageVersion = connected?.version ?? null;
  console.info(`[ainecto-panel] connected: ${hostName}`);
  const self = await callTool('identity_get_self', {});
  if (self.ok) me = { userId: self.data?.userId, displayName: self.data?.displayName };
  else showError(self, '내 정보를 읽지 못했습니다');
  host.onCommentMode?.((on) => {
    commentMode = on;
    render();
  });
  host.room?.on(onSignal);
  host.room?.onConnection((connected) => {
    const reconnected = connected && roomConnected === false && projectUuid;
    roomConnected = connected;
    updateAloneReads();
    if (!reconnected) return;
    refresh('conversation_list', listArgs());
    const c = shownConversationUuid();
    if (c) refresh('conversation_get_messages', messageArgs(c));
  });
  host.room?.onPeers(async (peers) => {
    roomPeers = peers;
    updateAloneReads();
    const ids = typingIn(peers, shownConversationUuid());
    const names = ids.length && host.room.names ? await host.room.names(ids) : {};
    typingNames = ids.map((id) => names[id] || '누군가');
    renderConversation();
  });
  ready = true;
  const project = connected?.projectUuid ?? pendingProject;
  if (project) useProject(project);
  else {
    banner = { text: '어느 프로젝트의 패널인지 정해지지 않았습니다. 대화에서 프로젝트 이름을 말하고 패널을 다시 열어 주세요', error: false };
    render();
  }
  updateCanAsk();
  checkVersion();
}
