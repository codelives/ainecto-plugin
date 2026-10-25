// Mod tests: `claude plugin test` from this directory. No session, network or AiNecto server:
// every $.mcp.call is answered by a stub that records what the mod asked for.
import { expect, mock, test } from 'claude-code/testing'

type Call = { server: string; tool: string; args: Record<string, unknown> }

const res = (body: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(body) }], isError: false })

const note = (id: string, seq: number, kind = 'COMMENT_MENTIONED', commentId: number | null = 639) => ({
  id,
  seq,
  kind,
  at: '2026-10-24T23:59:14Z',
  summary: `summary ${id}`,
  actor: { type: 'USER', name: 'Edwin PARK' },
  target: {
    type: 'KANBAN_CARD',
    uuid: 'card-1',
    title: 'Conversation 본체',
    projectName: 'AiNecto',
    commentId,
    url: 'https://ainecto.com/app/docs/board-1?card=card-1',
  },
  groupCount: 1,
  humanRead: false,
})

const summary = (unread: number) => ({
  notifications: { unread, unreadCapped: false, unreadByKind: { COMMENT_MENTIONED: unread } },
  mentionsToRead: { items: [note('m1', 167)], hasMore: false },
  todos: { open: 0, items: [] },
  cards: {
    assignedOpen: 1,
    pendingAcceptance: 1,
    inProgress: 0,
    inReview: 0,
    blocked: 0,
    hasMore: false,
    items: [
      {
        boardUuid: 'board-1',
        boardTitle: '10월 칸반보드',
        card: { uuid: 'card-9', key: 'KAN-9', title: '카드', status: 'TODO', assignmentState: 'PENDING' },
      },
    ],
  },
})

const PANE = {
  plugin: 'ainecto-panel',
  component: 'Pane',
  requestId: 'ainecto',
  viewport: { columns: 160, rows: 40 },
  props: {
    title: 'AiNecto',
    isFocused: true,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// Shared stubs. `state.unread` drives the summary; `state.list` answers list_notifications.
function stubs(on: any, state: { unread: number; list: (args: any) => unknown }) {
  const calls: Call[] = []
  const toasts: string[] = []
  const opened: any[] = []
  const saved = new Map<string, unknown>()
  const clock = mock.clock(on, { now: 1_000_000 })
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('tool.list', () => ({
    value: [
      { name: 'Read', description: '', mcp: false },
      { name: 'mcp__ai-erd__get_my_work_summary', description: '', mcp: true },
    ],
  }))
  on('mcp.call', ($: any, e: any) => {
    calls.push({ server: e.server, tool: e.tool, args: e.args })
    if (e.tool === 'get_my_work_summary') return { value: res(summary(state.unread)) }
    if (e.tool === 'list_notifications') return { value: res(state.list(e.args)) }
    if (e.tool === 'mark_notifications_read') {
      return { value: res({ results: e.args.items.map((i: any) => ({ id: i.id, ok: true })), unread: state.unread - 1 }) }
    }
    if (e.tool === 'list_comments') {
      return {
        value: res({
          comments: [
            { id: 603, parentCommentId: null, rootCommentId: 603 },
            { id: 639, parentCommentId: 603, rootCommentId: 603 },
          ],
        }),
      }
    }
    if (e.tool === 'create_comments') return { value: res({ results: [{ index: 0, ok: true, comment: { id: 700 } }] }) }
    return { deny: 'unexpected tool ' + e.tool }
  })
  on('ui.open', ($: any, e: any) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  return { calls, toasts, opened, saved, clock }
}

const listCalls = (calls: Call[]) => calls.filter((c) => c.tool === 'list_notifications')

test('reads the list only when the number changes, from its own cursor, never latest or ack', async ($, on) => {
  const state = {
    unread: 3,
    list: (args: any) =>
      args.cursor === 'saved'
        ? { items: [note('a', 10)], nextCursor: 'tok1', hasMore: false, ackToken: 'ack1' }
        : { items: [note('b', 11)], nextCursor: 'tok2', hasMore: false },
  }
  const s = stubs(on, state)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await s.clock.advance(1)

  expect(s.calls[0]).toEqual({ server: 'ai-erd', tool: 'get_my_work_summary', args: {} })
  expect(listCalls(s.calls).map((c) => c.args)).toEqual([{ cursor: 'saved', limit: 50 }])
  expect(s.saved.get('server')).toBe('ai-erd')
  expect(s.saved.get('cursor:ai-erd')).toBe('tok1')

  // Same number: the summary is read, the list is not.
  await s.clock.advance(30_000)
  expect(listCalls(s.calls).length).toBe(1)

  // The number changed: read on from the pane's own cursor.
  state.unread = 4
  await s.clock.advance(30_000)
  expect(listCalls(s.calls).map((c) => c.args.cursor)).toEqual(['saved', 'tok1'])
  expect(s.toasts).toEqual(['AiNecto · summary b'])

  for (const c of listCalls(s.calls)) {
    expect(c.args.cursor).not.toBe('latest')
    expect('ack' in c.args).toBe(false)
  }
})

test('waits out retryAfterSeconds before reading the list again', async ($, on) => {
  let limited = true
  const state = {
    unread: 1,
    list: () => (limited ? { items: [], retryAfterSeconds: 45 } : { items: [], nextCursor: 'tok', hasMore: false }),
  }
  const s = stubs(on, state)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await s.clock.advance(1)
  expect(listCalls(s.calls).length).toBe(1)
  limited = false
  await s.clock.advance(30_000) // 30 s < 45 s: still waiting
  expect(listCalls(s.calls).length).toBe(1)
  await s.clock.advance(30_000) // 60 s: allowed, and the number is still unconfirmed
  expect(listCalls(s.calls).length).toBe(2)
})

test('the pane shows the numbers, marks one read, and replies under the thread root', async ($, on) => {
  const state = { unread: 2, list: () => ({ items: [note('a', 10)], nextCursor: 'tok1', hasMore: false }) }
  const s = stubs(on, state)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await s.clock.advance(1)

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /안 읽음 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /summary m1/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'read-n-m1' })
  const read = s.calls.find((c) => c.tool === 'mark_notifications_read')
  expect(read?.args).toEqual({ items: [{ id: 'm1', seq: 167 }] })

  await ui.press({ key: 'tab-comments' })
  await ui.press({ key: 'reply-n-a' })
  await ui.input({ key: 'reply-input', text: '확인했습니다' })
  const sent = s.calls.find((c) => c.tool === 'create_comments')
  expect(sent?.args).toMatchObject({
    cardUuid: 'card-1',
    items: [{ body: '확인했습니다', parentCommentId: 603 }],
  })
  expect(String((sent?.args as any).items[0].clientMutationId)).toMatch(/^ainecto-panel:a:/)
  expect(s.toasts).toContain('AiNecto · 답글을 달았습니다')

  await ui.press({ key: 'tab-work' })
  expect(await ui.find({ type: 'Text', text: /KAN-9 카드/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /수락 대기 1/ })).toBeDefined()
})

test('/ainecto opens the pane with focus; a session start opens it without', async ($, on) => {
  const s = stubs(on, { unread: 0, list: () => ({ items: [], nextCursor: 't', hasMore: false }) })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(s.opened[0]).toEqual({ id: 'ainecto', title: 'AiNecto' })
  await $.command.run({ command: 'ainecto', args: '' })
  expect(s.opened[1]).toEqual({ id: 'ainecto', title: 'AiNecto', focus: true })
})

test('with no AiNecto server the pane says how to connect', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: 'Read', description: '', mcp: false }] }))
  on('mcp.call', () => ({ deny: 'no such server' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /AiNecto MCP 연결 없음.*setup/ })).toBeDefined()
})
