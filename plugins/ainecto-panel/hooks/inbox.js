// The AiNecto pane's data rules, as pure functions: no `$`, no I/O, no clock.
// Two panes draw what these return and import this same file, so they agree on what they show:
// the Claude Code mod (register.js) and the MCP App panel (mcp-app/panel.js, opened by ChatGPT,
// the Codex app and Claude). Unit tests: test/panel-inbox.test.mjs (node --test).

/** Notifications kept in the pane, newest first. */
export const KEEP = 100;

/** How often a pane reads get_my_work_summary while it is shown. */
export const POLL_MS = 30_000;
/** A failed read (MCP not connected yet, a blip) is retried this soon, at most QUICK_RETRY_MAX times in a row. */
export const QUICK_RETRY_MS = 5_000;
export const QUICK_RETRY_MAX = 6;

/** Server names tried when the session's tool list names no AiNecto server, in order. */
export const SERVER_CANDIDATES = [
  'ainecto', // `npx ainecto setup` and the ainecto plugin
  'plugin:ainecto:ainecto', // the ainecto plugin's own MCP entry
  'claude.ai AiNecto', // the claude.ai connector
  'ai-erd', // setups made before the AiNecto rename
];

/** The tool that marks an MCP server as AiNecto (every pane looks for it to find the server). */
export const PROBE_TOOL = 'get_my_work_summary';

/**
 * Picks the AiNecto MCP server from the session's tool names: a server is one that has
 * `get_my_work_summary`. Names in SERVER_CANDIDATES win, then the first one listed.
 * @param {string[]} toolNames tool names as the model sees them (`mcp__<server>__<tool>`)
 * @returns {string | null} the server as the tool name spells it (accepted by `$.mcp.call`)
 */
export function pickServer(toolNames) {
  const suffix = `__${PROBE_TOOL}`;
  const found = toolNames
    .filter((n) => n.startsWith('mcp__') && n.endsWith(suffix))
    .map((n) => n.slice('mcp__'.length, -suffix.length))
    .filter(Boolean);
  if (found.length === 0) return null;
  const spelled = (s) => s.replace(/[^A-Za-z0-9_-]/g, '_');
  for (const c of SERVER_CANDIDATES) {
    const hit = found.find((f) => f === c || f === spelled(c));
    if (hit) return hit;
  }
  return found[0];
}

/**
 * Reads an MCP tools/call result: the JSON body the AiNecto server puts in its first text block
 * (later blocks are hint lines such as «🔔 AiNecto: …»).
 * @returns {{ ok: true, data: any } | { ok: false, error: string }}
 */
export function parseToolResult(result) {
  if (!result || typeof result !== 'object') return { ok: false, error: 'empty result' };
  const texts = (result.content ?? []).filter((b) => b && b.type === 'text').map((b) => String(b.text ?? ''));
  if (result.isError) return { ok: false, error: texts.join(' ').slice(0, 500) || 'tool error' };
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return { ok: true, data: result.structuredContent };
  }
  for (const t of texts) {
    try {
      return { ok: true, data: JSON.parse(t) };
    } catch {
      // not the JSON block; try the next one
    }
  }
  return { ok: false, error: `no JSON body in result: ${texts.join(' ').slice(0, 200)}` };
}

/** Which tab a notification or to-do kind belongs to. */
export function groupOf(kind) {
  if (typeof kind !== 'string') return 'other';
  if (kind.startsWith('COMMENT_') || kind.startsWith('QUESTION_')) return 'comment';
  if (kind.startsWith('CARD_')) return 'work';
  return 'other';
}

/**
 * Normalizes get_my_work_summary into what the pane shows.
 * @returns {{ unread: number, unreadCapped: boolean, unreadByKind: Record<string, number>,
 *   mentions: any[], todos: any[], todosOpen: number, cards: any[], cardCounts: Record<string, number>, cardsHasMore: boolean }}
 */
export function summaryView(s) {
  const n = s?.notifications ?? {};
  const c = s?.cards ?? {};
  const t = s?.todos ?? {};
  return {
    unread: Number(n.unread ?? 0),
    unreadCapped: Boolean(n.unreadCapped),
    unreadByKind: n.unreadByKind ?? {},
    mentions: Array.isArray(s?.mentionsToRead?.items) ? s.mentionsToRead.items : [],
    todos: Array.isArray(t.items) ? t.items : [],
    todosOpen: Number(t.open ?? 0),
    cards: Array.isArray(c.items) ? c.items : [],
    cardCounts: {
      assignedOpen: Number(c.assignedOpen ?? 0),
      pendingAcceptance: Number(c.pendingAcceptance ?? 0),
      inProgress: Number(c.inProgress ?? 0),
      inReview: Number(c.inReview ?? 0),
      blocked: Number(c.blocked ?? 0),
    },
    cardsHasMore: Boolean(c.hasMore),
  };
}

/**
 * Merges notifications into the kept list. Same id: the higher seq wins (a grouped entry that
 * grew). A redacted item removes its id. Newest (highest seq) first, at most `keep`.
 * @returns {{ items: any[], fresh: any[] }} fresh = items that are new or grew, newest first
 */
export function mergeNotifications(existing, incoming, keep = KEEP) {
  const byId = new Map(existing.map((it) => [it.id, it]));
  const fresh = [];
  for (const it of incoming ?? []) {
    if (!it || !it.id) continue;
    if (it.redacted) {
      byId.delete(it.id);
      continue;
    }
    const old = byId.get(it.id);
    if (old && Number(old.seq) >= Number(it.seq)) continue;
    byId.set(it.id, it);
    fresh.push(it);
  }
  const items = [...byId.values()].sort((a, b) => Number(b.seq) - Number(a.seq)).slice(0, keep);
  const kept = new Set(items.map((it) => it.id));
  return { items, fresh: fresh.filter((it) => kept.has(it.id)).sort((a, b) => Number(b.seq) - Number(a.seq)) };
}

/**
 * Whether to read list_notifications now. Only when the unread number changed, or a backlog
 * page is still waiting (hasMore), and never before the server's retryAfter has passed:
 * the 30-second limit is shared with the agent on the same connection.
 */
export function shouldFetchList({ unread, lastUnread, hasMore, now, retryAt }) {
  if (now < (retryAt ?? 0)) return false;
  if (hasMore) return true;
  return lastUnread === undefined || lastUnread === null || unread !== lastUnread;
}

/**
 * The list_notifications arguments for the pane. The pane never sends `ack` and never uses
 * `latest`: with its own nextCursor the server neither reads nor moves the connection's saved
 * position; the first read uses `saved`, which reads from that position without moving it.
 */
export function listArgs(cursor) {
  return { cursor: cursor || 'saved', limit: 50 };
}

/** One status line under the prompt. */
export function statusText(view, error) {
  if (error) return `AiNecto ⚠ ${error}`;
  if (!view) return 'AiNecto …';
  const parts = [`🔔 ${view.unread}${view.unreadCapped ? '+' : ''}`];
  if (view.mentions.length) parts.push(`멘션 ${view.mentions.length}`);
  if (view.todosOpen) parts.push(`할 일 ${view.todosOpen}`);
  if (view.cardCounts.pendingAcceptance) parts.push(`수락 대기 ${view.cardCounts.pendingAcceptance}`);
  return `AiNecto ${parts.join(' · ')}`;
}

/** Toast text for notifications that just arrived. */
export function toastText(fresh) {
  if (!fresh.length) return null;
  if (fresh.length === 1) return `AiNecto · ${fresh[0].summary ?? fresh[0].kind}`;
  return `AiNecto · 새 알림 ${fresh.length}건`;
}

/**
 * Where a reply to this item goes: the parent (card or document) and the comment the
 * notification points at. The caller resolves a reply's thread root before sending, because
 * replies are one level deep.
 * @returns {{ cardUuid?: string, documentUuid?: string, commentId: number } | null}
 */
export function replyTarget(item) {
  const t = item?.target;
  if (!t || !t.uuid || t.commentId === null || t.commentId === undefined) return null;
  if (t.type === 'KANBAN_CARD') return { cardUuid: t.uuid, commentId: Number(t.commentId) };
  if (t.type === 'DOCUMENT') return { documentUuid: t.uuid, commentId: Number(t.commentId) };
  return null;
}

/** The top-level comment to reply under: the thread root of `commentId` in a list_comments body. */
export function threadRoot(comments, commentId) {
  const c = (comments ?? []).find((x) => Number(x.id) === Number(commentId));
  if (!c) return null;
  return Number(c.rootCommentId ?? c.parentCommentId ?? c.id);
}

/** mark_notifications_read items for these notifications. */
export function readItems(items) {
  return items.filter((it) => it && it.id && !it.redacted).map((it) => ({ id: it.id, seq: it.seq }));
}

/**
 * Applies mark_notifications_read results: ok items become humanRead.
 * @returns {any[]} a new list
 */
export function applyRead(items, results) {
  const done = new Set((results ?? []).filter((r) => r && r.ok).map((r) => r.id));
  return items.map((it) => (done.has(it.id) ? { ...it, humanRead: true } : it));
}

/**
 * A card's page on AiNecto, built from a card url the server already gave (a to-do or a
 * notification target), so the pane holds no host or path of its own.
 */
export function cardUrl(card, knownUrls) {
  const uuid = card?.card?.uuid;
  if (!uuid) return null;
  const urls = (knownUrls ?? []).filter(Boolean);
  const exact = urls.find((u) => u.includes(`card=${uuid}`));
  if (exact) return exact;
  for (const u of urls) {
    let url;
    try {
      url = new URL(u);
    } catch {
      continue;
    }
    if (!url.searchParams.has('card')) continue;
    const segments = url.pathname.split('/');
    if (card.boardUuid && segments.length) segments[segments.length - 1] = card.boardUuid;
    url.pathname = segments.join('/');
    url.searchParams.set('card', uuid);
    return url.href;
  }
  return null;
}

/**
 * The three tabs as rows both panes draw. A row: { key, title, detail, url, unread, actions }
 * with actions from 'read' (mark read) and 'reply'.
 */
export function buildTabs({ view, notifications }) {
  const mentions = view?.mentions ?? [];
  const todos = view?.todos ?? [];
  const merged = mergeNotifications(notifications ?? [], mentions).items;
  const urls = [...merged, ...todos].map((x) => x?.target?.url);
  const todoIds = new Set(todos.map((td) => td.todoId));

  const notificationRow = (it) => ({
    key: `n-${it.id}`,
    id: it.id,
    title: it.summary ?? it.kind,
    detail: [it.actor?.name, it.target?.projectName, shortTime(it.at)].filter(Boolean).join(' · '),
    url: it.target?.url ?? null,
    unread: !it.humanRead,
    actions: [...(!it.humanRead ? ['read'] : []), ...(replyTarget(it) && groupOf(it.kind) === 'comment' ? ['reply'] : [])],
    item: it,
  });

  const todoRow = (td) => ({
    key: `t-${td.todoId}`,
    id: td.todoId,
    title: td.summary ?? td.kind,
    detail: ['할 일', td.target?.projectName, shortTime(td.openedAt)].filter(Boolean).join(' · '),
    url: td.target?.url ?? null,
    unread: true,
    actions: replyTarget(td) ? ['reply'] : [],
    item: td,
  });

  const cardRow = (c) => ({
    key: `c-${c.card?.uuid}`,
    id: c.card?.uuid,
    title: `${c.card?.key ?? ''} ${c.card?.title ?? ''}`.trim(),
    detail: [cardState(c.card), c.boardTitle].filter(Boolean).join(' · '),
    url: cardUrl(c, urls),
    unread: c.card?.assignmentState === 'PENDING',
    actions: [],
    item: c,
  });

  return {
    notifications: merged.map(notificationRow),
    comments: [
      ...todos.filter((td) => groupOf(td.kind) === 'comment').map(todoRow),
      // a notification that opened one of those to-dos is the same question: show it once
      ...merged
        .filter((it) => groupOf(it.kind) === 'comment' && !(it.todoId && todoIds.has(it.todoId)))
        .map(notificationRow),
    ],
    work: (view?.cards ?? []).map(cardRow),
  };
}

const STATUS_KO = { TODO: '할 일', IN_PROGRESS: '진행 중', IN_REVIEW: '검토 중', DONE: '완료' };

function cardState(card) {
  if (!card) return '';
  const parts = [];
  if (card.assignmentState === 'PENDING') parts.push('수락 대기');
  parts.push(STATUS_KO[card.status] ?? card.status);
  if (card.blocked) parts.push('막힘');
  if (card.priority === 'URGENT') parts.push('긴급');
  return parts.join(' · ');
}

/** An ISO time as `MM-DD HH:MM` in the local time zone, or '' when it does not parse. */
function shortTime(iso) {
  if (typeof iso !== 'string' || iso.length < 16) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Idempotency key for a reply: the same text sent again for the same item reuses the key, so
 * a retry after a timeout does not post (or mail) twice.
 */
export function mutationId(itemId, text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `ainecto-panel:${itemId}:${h.toString(16)}`.slice(0, 128);
}
