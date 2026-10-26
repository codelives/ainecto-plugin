// A stand-in for the Claude artifact runtime (window.claude.use) and an AiNecto server behind it, for
// test/artifact-page.e2e.mjs. Injected before the page's own script. It answers the panel's tools from an in-page
// store shaped like the real tool results (ainecto-api conversation/inbox handlers), keeps watches the way
// mcp.watchTool does (run now, run again on invalidate or __fake.tick()), and records every call, room emit,
// presence patch and sendToClaudeSession so the test can assert on them.
(() => {
  const ME = 'me-0000-0000-0000-000000000001';
  const EDWIN = 'ed-0000-0000-0000-000000000002';
  const PROJECT = window.__FAKE_PROJECT__;
  const ROOM = 'room-0000-0000-0000-000000000010';
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const names = { [ME]: '라이언', [EDWIN]: 'Edwin PARK' };

  const store = {
    conversations: [{ uuid: ROOM, type: 'PROJECT_ROOM', users: null }],
    messages: {
      [ROOM]: [
        { seq: 1, uuid: 'm-1', author: EDWIN, body: '패널 1단계에 착수했습니다.\n구현 범위를 정리해 뒀어요.', at: iso(600_000) },
        { seq: 2, uuid: 'm-2', author: ME, body: '좋아요. AI에게 검토 맡기고 의견 정리해서 전달할게요.', at: iso(300_000) },
      ],
    },
    read: { [ROOM]: { [ME]: 1, [EDWIN]: 2 } },
    receipts: {},
    notifications: [
      {
        id: 'n-1', seq: 41, kind: 'CARD_REVIEW_REQUESTED', at: iso(120_000),
        summary: 'Edwin PARK님이 업무 검토를 요청했습니다. — Claude·Claude Code 협업 연동',
        actor: { type: 'USER', name: 'Edwin PARK', agent: null },
        target: { type: 'KANBAN_CARD', uuid: 'card-1', title: 'Claude·Claude Code 협업 연동', projectName: '테스트 프로젝트', commentId: null, url: 'https://dev.ainecto.com/app/docs/b?card=card-1' },
        groupCount: 1, action: 'review', todoId: null, humanRead: false,
      },
      {
        id: 'n-2', seq: 40, kind: 'DOCUMENT_UPDATED', at: iso(3_600_000),
        summary: 'Edwin PARK님이 문서를 수정했습니다. — 패널 협업 연동 기능 정의서',
        actor: { type: 'USER', name: 'Edwin PARK', agent: null },
        target: { type: 'DOCUMENT', uuid: 'doc-1', title: '패널 협업 연동 기능 정의서', projectName: '테스트 프로젝트', commentId: null, url: 'https://dev.ainecto.com/app/docs/doc-1' },
        groupCount: 2, action: 'read', todoId: null, documentChange: { changeCount: 2, versionSummary: '새 버전이 등록되었습니다' }, humanRead: false,
      },
    ],
  };
  const calls = [];
  const emitted = [];
  const presence = [];
  const sentToClaude = [];
  const refusedToClaude = []; // {deliver: 'send'} calls refused with __fake.refuseSend
  const watches = [];
  const listeners = { conv: [], peers: [], connection: [] };

  const result = (body) => ({ content: [{ type: 'text', text: JSON.stringify(body) }], payload: body });
  const latest = (c) => (store.messages[c] ?? []).reduce((n, m) => Math.max(n, m.seq), 0);
  const members = () => [ME, EDWIN].map((userId) => ({ userId, displayName: names[userId], jobTitle: userId === EDWIN ? 'Product Owner' : 'Software Architect' }));
  const message = (c, m) => ({
    seq: m.seq, uuid: m.uuid, author: { userId: m.author, displayName: names[m.author] ?? null }, body: m.body, at: m.at, registeredBy: null,
    readCount: Object.entries(store.read[c] ?? {}).filter(([u, s]) => u !== m.author && s >= m.seq).length,
  });
  const summaryOf = (c) => {
    const msgs = store.messages[c.uuid] ?? [];
    const last = msgs[msgs.length - 1];
    const other = c.users ? c.users.find((u) => u !== ME) : null;
    const mine = store.read[c.uuid]?.[ME] ?? 0;
    return {
      conversationUuid: c.uuid, type: c.type, name: other ? names[other] : '테스트 프로젝트', withUserId: other,
      unreadCount: msgs.filter((m) => m.seq > mine && m.author !== ME).length, latestSeq: latest(c.uuid), myLastReadSeq: mine,
      lastMessage: last ? { seq: last.seq, author: { userId: last.author, displayName: names[last.author] }, preview: last.body.slice(0, 200), at: last.at } : null,
    };
  };

  function append(c, author, body) {
    const seq = latest(c) + 1;
    const m = { seq, uuid: `m-${c.slice(0, 4)}-${seq}`, author, body, at: new Date().toISOString() };
    (store.messages[c] ??= []).push(m);
    store.read[c] = { ...(store.read[c] ?? {}), [author]: seq };
    return m;
  }

  const tools = {
    identity_get_self: () => ({ userId: ME, displayName: names[ME] }),
    conversation_list: ({ projectUuid }) => {
      if (projectUuid !== PROJECT) throw Object.assign(new Error('404 project not found'), { code: 'tool_error' });
      const mine = store.conversations.filter((c) => !c.users || c.users.includes(ME));
      return { notice: 'Message bodies…', projectUuid, projectName: '테스트 프로젝트', conversations: mine.map(summaryOf), members: members(), memberCount: 2 };
    },
    // As ConversationService.messages: at most 50; hasMore = older ones exist (the latest page) or newer ones exist
    // (afterSeq).
    conversation_get_messages: ({ conversationUuid, limit = 20, afterSeq }) => {
      const all = store.messages[conversationUuid] ?? [];
      const size = Math.min(limit, 50);
      const msgs = afterSeq !== undefined ? all.filter((m) => m.seq > afterSeq).slice(0, size) : all.slice(-size);
      const hasMore = msgs.length > 0 && (afterSeq !== undefined ? all.at(-1).seq > msgs.at(-1).seq : all[0].seq < msgs[0].seq);
      const c = store.conversations.find((x) => x.uuid === conversationUuid);
      return { notice: '…', conversationUuid, type: c.type, projectUuid: PROJECT, messages: msgs.map((m) => message(conversationUuid, m)), hasMore, latestSeq: latest(conversationUuid), myLastReadSeq: store.read[conversationUuid]?.[ME] ?? 0 };
    },
    conversation_send: (args) => {
      if (args.clientMutationId && store.receipts[args.clientMutationId]) return store.receipts[args.clientMutationId];
      let c = args.conversationUuid;
      if (!c && args.to?.userId) {
        const found = store.conversations.find((x) => x.users && x.users.includes(args.to.userId) && x.users.includes(ME));
        if (found) c = found.uuid;
        else {
          c = `chat-${args.to.userId.slice(0, 4)}-0000-0000-000000000099`;
          store.conversations.push({ uuid: c, type: 'DIRECT', users: [ME, args.to.userId] });
        }
      }
      const m = append(c, ME, args.body);
      const conv = store.conversations.find((x) => x.uuid === c);
      const out = { conversationUuid: c, type: conv.type, seq: m.seq, messageUuid: m.uuid, at: m.at };
      if (args.clientMutationId) store.receipts[args.clientMutationId] = out;
      return out;
    },
    conversation_mark_read: ({ conversationUuid, throughSeq }) => {
      const r = (store.read[conversationUuid] ??= {});
      r[ME] = Math.max(r[ME] ?? 0, Math.min(throughSeq ?? latest(conversationUuid), latest(conversationUuid)));
      return { conversationUuid, lastReadSeq: r[ME], unreadCount: 0, notificationsRead: 0 };
    },
    get_my_work_summary: () => ({ notifications: { unread: store.notifications.filter((n) => !n.humanRead).length, unreadCapped: false } }),
    list_notifications: ({ order }) => ({ items: order === 'newest' ? store.notifications : [...store.notifications].reverse(), nextCursor: null, hasMore: false, order }),
    // KAN-404: the newest panel version as ainecto-api names it (window.__FAKE_LATEST_VERSION__; absent = an older
    // server that names none).
    open_ainecto_panel: ({ projectUuid } = {}) => ({
      notifications: { unread: 0 },
      panel: { label: 'Claude app panel', projectUuid, ...(window.__FAKE_LATEST_VERSION__ ? { artifactVersion: window.__FAKE_LATEST_VERSION__ } : {}) },
    }),
    mark_notifications_read: ({ items }) => {
      for (const it of items) {
        const n = store.notifications.find((x) => x.id === it.id);
        if (n) n.humanRead = true;
      }
      return { results: items.map((it) => ({ id: it.id, ok: true })) };
    },
  };
  const READ_ONLY = new Set(['identity_get_self', 'conversation_list', 'conversation_get_messages', 'get_my_work_summary', 'list_notifications', 'open_ainecto_panel']);

  // Send controls for the test: hold the answer to conversation_send (stored at once, answered on release),
  // or fail the next sends before they are stored (server_unavailable).
  const sendControl = { held: null, failures: 0, readFailure: null, canSend: window.__FAKE_CAN_SEND__ ?? 'available', sendRefusal: null };
  async function run(tool, input) {
    await Promise.resolve();
    if (tool === 'conversation_send' && sendControl.failures > 0) {
      sendControl.failures -= 1;
      throw { code: 'server_unavailable', message: 'timeout', retryable: true };
    }
    if (tool === 'conversation_send' && sendControl.held) {
      const out = result(tools[tool](input ?? {}));
      await sendControl.held.promise;
      return out;
    }
    if (!tools[tool]) throw Object.assign(new Error(`not in manifest: ${tool}`), { code: 'not_in_manifest' });
    return result(tools[tool](input ?? {}));
  }

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function runWatch(w) {
    run(w.tool, w.input).then((r) => w.live && w.handler({ type: 'data', result: r }), (e) => w.live && w.handler({ type: 'error', error: e }));
  }

  const mcp = Object.freeze({
    listTools: async () => ({ servers: [{ server: 'AiNecto dev', authStatus: 'connected', tools: Object.keys(tools).map((name) => ({ name, description: '' })) }] }),
    callTool: async (server, tool, input, opts) => {
      calls.push({ tool, input, opts: opts ?? null, at: Date.now() });
      if (tool === 'conversation_get_messages' && sendControl.readFailure) {
        const code = sendControl.readFailure;
        throw { code, message: code, retryable: code === 'rate_limited' || code === 'server_unavailable', retryAfterMs: 1000 };
      }
      return run(tool, input);
    },
    watchTool: (server, tool, input, handler, opts) => {
      calls.push({ tool, input, watch: opts ?? null });
      const w = { tool, input, handler, live: true };
      if (!READ_ONLY.has(tool)) {
        // the runtime refuses to watch a declared write
        setTimeout(() => handler({ type: 'error', error: { code: 'bad_request', message: `watch of a write: ${tool}` } }), 0);
        return () => {};
      }
      watches.push(w);
      runWatch(w);
      return () => {
        w.live = false;
      };
    },
    invalidate: async (server, tool, input) => {
      calls.push({ invalidate: tool, input });
      for (const w of watches) if (w.live && w.tool === tool && (input === undefined || same(w.input, input))) runWatch(w);
    },
  });

  const room = Object.freeze({
    emit: async (topic, data) => {
      emitted.push({ topic, data });
      for (const fn of listeners.conv) fn({ topic, data, peer: 'self', by: 'claude-me', isMe: true, sameTab: true, kind: 'viewer', guest: false });
    },
    on: (topic, fn) => {
      if (topic === 'conv') listeners.conv.push(fn);
      return () => {};
    },
    onConnection: (fn) => {
      listeners.connection.push(fn);
      setTimeout(() => fn(true), 0);
      return () => {};
    },
    connected: () => true,
    presence: async (patch) => {
      presence.push(patch);
    },
    peers: () => [],
    onPeers: (fn) => {
      listeners.peers.push(fn);
      return () => {};
    },
    canSendToClaudeSession: async () => sendControl.canSend,
    sendToClaudeSession: (data, opts) => {
      if (!window.__inClick) return Promise.reject(Object.assign(new Error('no gesture'), { code: 'claude_unavailable' }));
      if (opts?.deliver === 'send' && sendControl.sendRefusal) {
        refusedToClaude.push({ data, opts });
        return Promise.reject(Object.assign(new Error('cannot ask here'), { code: sendControl.sendRefusal }));
      }
      sentToClaude.push({ data, opts });
      return Promise.resolve({ to: 'pane' });
    },
  });
  // A click is a gesture only while its handlers run (the real runtime proves it from the call itself).
  document.addEventListener('click', () => {
    window.__inClick = true;
    setTimeout(() => (window.__inClick = false), 0);
  }, true);

  const user = Object.freeze({ profiles: async (ids) => Object.fromEntries(ids.map((id) => [id, { id, name: id === 'claude-edwin' ? 'Edwin' : '', avatarUrl: '', color: '#888', email: null, isMe: false, guest: false }])) });
  const permissions = Object.freeze({ state: async () => 'granted', request: async () => ({}), manage: async () => {} });
  // comments (KAN-392), only when the test asks for it (window.__FAKE_COMMENTS__): canSendToClaude, anchorFor,
  // sendToClaude (gesture-checked like room), customAnchors. While comment mode is on and no page registered
  // customAnchors, the shell takes every click inside the artifact (as claude.ai's click-to-comment does).
  const commentsControl = { can: window.__FAKE_COMMENTS__ ?? null, refusal: null, sent: [], anchors: null, mode: false, placed: [], exits: 0 };
  const comments = Object.freeze({
    canSendToClaude: async () => commentsControl.can,
    anchorFor: async (el) => {
      if (!(el instanceof Element) || !el.isConnected) throw Object.assign(new Error('not attached'), { code: 'invalid' });
      return { path: el.tagName.toLowerCase(), x: 0.5, y: 0.5 };
    },
    sendToClaude: async (target) => {
      if (!window.__inClick) throw Object.assign(new Error('no gesture'), { code: 'claude_unavailable' });
      if (commentsControl.refusal) throw Object.assign(new Error('refused'), { code: commentsControl.refusal });
      if (new TextEncoder().encode(target.text).length > 4096) throw Object.assign(new Error('too long'), { code: 'invalid' });
      commentsControl.sent.push(target);
      return { threadId: `t-${commentsControl.sent.length}`, commentId: 'c' };
    },
    customAnchors: async (callbacks) => {
      commentsControl.anchors = callbacks;
      callbacks.mode(commentsControl.mode);
      callbacks.threads([]);
      return Object.freeze({
        placed: (map) => commentsControl.placed.push(map),
        exitMode: () => {
          commentsControl.exits += 1;
          commentsControl.mode = false;
          callbacks.mode(false);
        },
        release: () => (commentsControl.anchors = null),
      });
    },
  });
  document.addEventListener('click', (event) => {
    if (commentsControl.mode && !commentsControl.anchors) {
      event.stopPropagation();
      event.preventDefault();
    }
  }, true);
  const caps = { mcp, room, user, permissions, ...(commentsControl.can ? { comments } : {}) };

  window.claude = Object.freeze({ use: (name) => new Promise((resolve) => setTimeout(() => resolve(caps[name] ?? null), 5)) });
  window.__fake = {
    ME, EDWIN, ROOM, store, calls, emitted, presence, sentToClaude, refusedToClaude,
    /** What canSendToClaudeSession answers from now on (the page re-checks on a tab change). */
    canSend: (state) => (sendControl.canSend = state),
    /** Every {deliver: 'send'} is refused with this code from now on (null: taken again). */
    refuseSend: (code) => (sendControl.sendRefusal = code),
    /** Someone else stored a message (on the server only — no signal). */
    serverMessage: (c, author, body) => append(c, author, body).seq,
    /** A room signal from another viewer. */
    signal: (data) => listeners.conv.forEach((fn) => fn({ topic: 'conv', data, peer: 'p-other', by: 'claude-edwin', isMe: false, sameTab: false, kind: 'viewer', guest: false })),
    /** The watch interval fires (as watchTool's refetchInterval would). */
    tick: () => watches.filter((w) => w.live).forEach(runWatch),
    hold: () => {
      let release;
      const promise = new Promise((r) => (release = r));
      sendControl.held = { promise, release };
    },
    release: () => {
      sendControl.held?.release();
      sendControl.held = null;
    },
    failNext: (n = 1) => (sendControl.failures = n),
    /** Every conversation_get_messages callTool fails with this code from now on (null: answer again). */
    failReads: (code) => (sendControl.readFailure = code),
    comments: commentsControl,
    /** The viewer turns comment mode on from the shell. */
    commentMode: (on) => {
      commentsControl.mode = on;
      commentsControl.anchors?.mode(on);
    },
    /** comments.sendToClaude rejects with this code from now on (null: taken again). */
    refuseComment: (code) => (commentsControl.refusal = code),
    peers: (list) => listeners.peers.forEach((fn) => fn({ peers: list, joined: [], left: [], updated: list })),
  };
})();
