// Unit tests for the AiNecto pane's pure data rules (plugins/ainecto-panel/hooks/inbox.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRead,
  buildTabs,
  cardUrl,
  groupOf,
  KEEP,
  listArgs,
  mergeNotifications,
  mutationId,
  parseToolResult,
  pickServer,
  readItems,
  replyTarget,
  shouldFetchList,
  statusText,
  summaryView,
  threadRoot,
  toastText,
} from '../plugins/ainecto-panel/hooks/inbox.js';

const BOARD = '1b906f6daddb444fbbcdd850cd89fb08';
const urlOf = (card) => `https://ainecto.com/app/docs/${BOARD}?card=${card}`;
const note = (id, seq, extra = {}) => ({
  id,
  seq,
  kind: 'COMMENT_MENTIONED',
  at: '2026-10-24T23:59:14.768434Z',
  summary: `n${id}`,
  actor: { name: 'Edwin PARK' },
  target: { type: 'KANBAN_CARD', uuid: `card-${id}`, projectName: 'AiNecto', commentId: 600 + seq, url: urlOf(`card-${id}`) },
  groupCount: 1,
  humanRead: false,
  ...extra,
});

// Shape copied from a real get_my_work_summary response (2026-10-25, trimmed).
const SUMMARY = {
  notifications: { unread: 37, unreadCapped: false, unreadByKind: { CARD_ASSIGNED: 29, COMMENT_MENTIONED: 4 } },
  mentionsToRead: { items: [note('m1', 167)], hasMore: false },
  todos: {
    open: 19,
    items: [
      {
        todoId: 't1',
        kind: 'CARD_ASSIGNED',
        summary: 'Edwin PARK assigned you a work item.',
        openedAt: '2026-10-24T10:09:08Z',
        target: { type: 'KANBAN_CARD', uuid: 'e638', commentId: null, url: urlOf('e638') },
      },
      {
        todoId: 't2',
        kind: 'QUESTION_MENTIONED',
        summary: 'Mina asked you a question.',
        openedAt: '2026-10-24T11:00:00Z',
        target: { type: 'DOCUMENT', uuid: 'doc-1', commentId: 41, url: 'https://ainecto.com/app/docs/doc-1' },
      },
    ],
  },
  cards: {
    assignedOpen: 48,
    pendingAcceptance: 19,
    inProgress: 11,
    inReview: 11,
    blocked: 0,
    hasMore: true,
    items: [
      {
        boardUuid: BOARD,
        boardTitle: '10월 칸반보드',
        card: { uuid: 'bde5', key: 'KAN-368', title: '패널', status: 'IN_PROGRESS', priority: 'URGENT', assignmentState: 'ACCEPTED' },
      },
    ],
  },
};

test('pickServer: finds the server that has get_my_work_summary, preferring known names', () => {
  assert.equal(pickServer(['Read', 'mcp__ai-erd__get_my_work_summary', 'mcp__ai-erd__list_notifications']), 'ai-erd');
  assert.equal(
    pickServer(['mcp__claude_ai_AiNecto__get_my_work_summary', 'mcp__ainecto__get_my_work_summary']),
    'ainecto',
  );
  assert.equal(pickServer(['mcp__claude_ai_AiNecto__get_my_work_summary']), 'claude_ai_AiNecto');
  assert.equal(pickServer(['mcp__other__list_notifications', 'Bash']), null);
});

test('parseToolResult: reads the JSON block, skips hint lines, reports errors', () => {
  const ok = parseToolResult({
    content: [{ type: 'text', text: '{"a":1}' }, { type: 'text', text: '🔔 AiNecto: 3 unread' }],
    isError: false,
  });
  assert.deepEqual(ok, { ok: true, data: { a: 1 } });
  assert.deepEqual(parseToolResult({ content: [{ type: 'text', text: 'hint' }, { type: 'text', text: '{"b":2}' }] }), {
    ok: true,
    data: { b: 2 },
  });
  assert.equal(parseToolResult({ content: [{ type: 'text', text: 'boom' }], isError: true }).ok, false);
  assert.equal(parseToolResult({ content: [{ type: 'text', text: 'no json' }] }).ok, false);
  assert.equal(parseToolResult(null).ok, false);
});

test('summaryView: normalizes the real response shape', () => {
  const v = summaryView(SUMMARY);
  assert.equal(v.unread, 37);
  assert.equal(v.mentions.length, 1);
  assert.equal(v.todosOpen, 19);
  assert.equal(v.cardCounts.pendingAcceptance, 19);
  assert.equal(v.cards[0].card.key, 'KAN-368');
  assert.deepEqual(summaryView(undefined).cards, []);
});

test('mergeNotifications: dedupes by id, higher seq wins, redacted removes, newest first, capped', () => {
  const a = mergeNotifications([], [note('x', 1), note('y', 2)]);
  assert.deepEqual(a.items.map((i) => i.id), ['y', 'x']);
  assert.deepEqual(a.fresh.map((i) => i.id), ['y', 'x']);

  const same = mergeNotifications(a.items, [note('x', 1)]);
  assert.equal(same.fresh.length, 0, 'the same id and seq again is not fresh');

  const grown = mergeNotifications(a.items, [note('x', 5, { groupCount: 3 })]);
  assert.deepEqual(grown.items.map((i) => [i.id, i.seq]), [['x', 5], ['y', 2]]);
  assert.deepEqual(grown.fresh.map((i) => i.id), ['x']);

  const older = mergeNotifications(grown.items, [note('x', 3)]);
  assert.equal(older.items.find((i) => i.id === 'x').seq, 5, 'an older copy never replaces a newer one');

  const redacted = mergeNotifications(grown.items, [{ id: 'y', seq: 9, redacted: true }]);
  assert.deepEqual(redacted.items.map((i) => i.id), ['x']);

  const many = Array.from({ length: KEEP + 10 }, (_, i) => note(`k${i}`, i + 1));
  const capped = mergeNotifications([], many);
  assert.equal(capped.items.length, KEEP);
  assert.equal(capped.items[0].seq, KEEP + 10);
  assert.ok(capped.fresh.every((f) => capped.items.includes(f)), 'fresh holds only kept items');
});

test('shouldFetchList: only when the number changed or a page waits, never before retryAt', () => {
  const base = { unread: 3, lastUnread: 3, hasMore: false, now: 100_000, retryAt: 0 };
  assert.equal(shouldFetchList(base), false);
  assert.equal(shouldFetchList({ ...base, unread: 4 }), true);
  assert.equal(shouldFetchList({ ...base, unread: 2 }), true);
  assert.equal(shouldFetchList({ ...base, lastUnread: null }), true, 'first read');
  assert.equal(shouldFetchList({ ...base, hasMore: true }), true);
  assert.equal(shouldFetchList({ ...base, unread: 4, retryAt: 120_000 }), false, 'waits out retryAfter');
});

test('listArgs: first read is saved, then the own nextCursor — never latest, never ack', () => {
  assert.deepEqual(listArgs(null), { cursor: 'saved', limit: 50 });
  assert.deepEqual(listArgs('tok'), { cursor: 'tok', limit: 50 });
  for (const args of [listArgs(null), listArgs('tok')]) {
    assert.notEqual(args.cursor, 'latest');
    assert.ok(!('ack' in args));
  }
});

test('groupOf: comment / work / other', () => {
  assert.equal(groupOf('COMMENT_REPLIED'), 'comment');
  assert.equal(groupOf('QUESTION_MENTIONED'), 'comment');
  assert.equal(groupOf('CARD_ASSIGNED'), 'work');
  assert.equal(groupOf('DOCUMENT_UPDATED'), 'other');
  assert.equal(groupOf(undefined), 'other');
});

test('replyTarget and threadRoot: card or document, reply under the thread root', () => {
  assert.deepEqual(replyTarget(note('a', 1)), { cardUuid: 'card-a', commentId: 601 });
  assert.deepEqual(replyTarget(SUMMARY.todos.items[1]), { documentUuid: 'doc-1', commentId: 41 });
  assert.equal(replyTarget(SUMMARY.todos.items[0]), null, 'no comment to reply to');
  assert.equal(replyTarget({ target: { type: 'PROJECT', uuid: 'p', commentId: 1 } }), null);
  const comments = [
    { id: 603, parentCommentId: null, rootCommentId: 603 },
    { id: 639, parentCommentId: 603, rootCommentId: 603 },
  ];
  assert.equal(threadRoot(comments, 639), 603);
  assert.equal(threadRoot(comments, 603), 603);
  assert.equal(threadRoot(comments, 1), null);
});

test('readItems and applyRead: id and seq out, ok results become read', () => {
  const items = [note('a', 1), note('b', 2), { id: 'c', seq: 3, redacted: true }];
  assert.deepEqual(readItems(items), [
    { id: 'a', seq: 1 },
    { id: 'b', seq: 2 },
  ]);
  const after = applyRead(items, [{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'STALE' }]);
  assert.equal(after[0].humanRead, true);
  assert.equal(after[1].humanRead, false);
  assert.equal(items[0].humanRead, false, 'input is not changed');
});

test('cardUrl: from a server url, never from a host of our own', () => {
  const card = SUMMARY.cards.items[0];
  assert.equal(cardUrl(card, [urlOf('bde5')]), urlOf('bde5'));
  assert.equal(cardUrl(card, [urlOf('other')]), urlOf('bde5'));
  assert.equal(cardUrl(card, ['https://ainecto.com/app/docs/doc-1']), null, 'a document url is no template');
  assert.equal(cardUrl(card, []), null);
});

test('buildTabs: three tabs; mentions join the list; a to-do and its notification show once', () => {
  const view = summaryView(SUMMARY);
  const linked = note('q', 50, { kind: 'QUESTION_MENTIONED', todoId: 't2' });
  const tabs = buildTabs({ view, notifications: [note('m1', 167), note('w', 10, { kind: 'CARD_ASSIGNED', humanRead: true }), linked] });
  assert.deepEqual(tabs.notifications.map((r) => r.id), ['m1', 'q', 'w']);
  assert.deepEqual(tabs.notifications[0].actions, ['read', 'reply']);
  assert.deepEqual(tabs.notifications[2].actions, [], 'read work item: nothing to do');
  assert.deepEqual(tabs.comments.map((r) => r.id), ['t2', 'm1'], 'card to-do stays out; question shows once');
  assert.equal(tabs.work.length, 1);
  assert.equal(tabs.work[0].title, 'KAN-368 패널');
  assert.equal(tabs.work[0].url, urlOf('bde5'));
  assert.match(tabs.work[0].detail, /진행 중 · 긴급/);
});

test('statusText and toastText', () => {
  const view = summaryView(SUMMARY);
  assert.equal(statusText(view, null), 'AiNecto 🔔 37 · 멘션 1 · 할 일 19 · 수락 대기 19');
  assert.equal(statusText(view, '동기화 실패'), 'AiNecto ⚠ 동기화 실패');
  assert.equal(toastText([]), null);
  assert.equal(toastText([note('a', 1)]), 'AiNecto · na');
  assert.equal(toastText([note('a', 1), note('b', 2)]), 'AiNecto · 새 알림 2건');
});

test('mutationId: stable for the same item and text, different otherwise, at most 128 chars', () => {
  assert.equal(mutationId('n1', '좋아요'), mutationId('n1', '좋아요'));
  assert.notEqual(mutationId('n1', '좋아요'), mutationId('n1', '좋아요!'));
  assert.notEqual(mutationId('n1', 'x'), mutationId('n2', 'x'));
  assert.ok(mutationId('x'.repeat(200), 'y').length <= 128);
});
