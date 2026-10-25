// AiNecto pane for Claude Code (KAN-368 stage 1): notifications, comments you can reply to, and your
// kanban work, beside the conversation. Data comes only from AiNecto MCP tools the user already
// connected, through $.mcp.call. No server of its own, no secrets.
//
// Reading rules (why the loop looks like this):
// - The numbers come from get_my_work_summary every POLL_MS. It has no rate limit and marks nothing.
// - list_notifications has a 30-second limit per user and connection, shared with the agent on the
//   same connection, so the pane reads it only when the unread number changed (or a backlog page is
//   waiting) and waits out retryAfterSeconds.
// - The pane never sends `ack` and never uses `latest`: it keeps the nextCursor it was given and reads
//   on from it, which the server neither reads nor moves. So the agent's own position is untouched.
import {
  applyRead,
  buildTabs,
  listArgs,
  mergeNotifications,
  mutationId,
  parseToolResult,
  pickServer,
  POLL_MS,
  QUICK_RETRY_MAX,
  QUICK_RETRY_MS,
  readItems,
  replyTarget,
  SERVER_CANDIDATES,
  shouldFetchList,
  statusText,
  summaryView,
  threadRoot,
  toastText,
} from './inbox.js'

const PANE = 'ainecto'

// Pane state. Module variables: lost on a reload, rebuilt by the next poll.
let server = null
let view = null
let notifications = []
let cursor = null
let hasMore = false
let lastUnread = null
let retryAt = 0
let lastSyncAt = null
let error = null
let busy = false
let caughtUp = false
let tab = 'notifications'
let replying = null
let draft = ''
let callSeq = 0
let quickRetries = 0

const TABS = [
  ['notifications', '알림', '1'],
  ['comments', '댓글', '2'],
  ['work', '업무', '3'],
]

// ── The one place this mod talks to AiNecto: every call writes a request and a response line ──
async function callTool($, tool, args) {
  const id = ++callSeq
  const started = await $.clock.now()
  $.ui.log(`ainecto → #${id} ${server} ${tool} args=${Object.keys(args ?? {}).join(',')}`, { to: 'debug' })
  let parsed
  try {
    parsed = parseToolResult(await $.mcp.call(server, tool, args))
  } catch (err) {
    parsed = { ok: false, error: String(err?.message ?? err) }
  }
  const ms = (await $.clock.now()) - started
  $.ui.log(
    `ainecto ← #${id} ${tool} ${parsed.ok ? 'ok' : 'error: ' + parsed.error} ${ms}ms`,
    { to: 'debug' },
  )
  return parsed
}

async function storeKey($, key, value) {
  try {
    await $.store.set(key, value)
  } catch (err) {
    $.ui.log(`ainecto store.set ${key} failed: ${err?.message ?? err}`, { to: 'debug' })
  }
}

async function loadSaved($) {
  const saved = await $.store.get('server')
  if (typeof saved === 'string') server = saved
  if (!server) return
  const c = await $.store.get('cursor:' + server)
  cursor = typeof c === 'string' ? c : null
  const items = await $.store.get('items:' + server)
  notifications = Array.isArray(items) ? items : []
}

async function useServer($, name) {
  server = name
  await storeKey($, 'server', name)
  const c = await $.store.get('cursor:' + name)
  cursor = typeof c === 'string' ? c : null
  const items = await $.store.get('items:' + name)
  notifications = Array.isArray(items) ? items : []
}

// Finds the user's AiNecto MCP server: the stored one, else the one whose tools the session lists,
// else the first known name that answers.
async function findServer($) {
  if (server) return server
  let names = []
  try {
    names = (await $.tool.list()).filter((t) => t.mcp).map((t) => t.name)
  } catch (err) {
    $.ui.log(`ainecto tool.list failed: ${err?.message ?? err}`, { to: 'debug' })
  }
  const picked = pickServer(names)
  if (picked) {
    await useServer($, picked)
    return picked
  }
  for (const name of SERVER_CANDIDATES) {
    server = name
    if ((await callTool($, 'get_my_work_summary', {})).ok) {
      await useServer($, name)
      return name
    }
  }
  server = null
  return null
}

// MCP servers connect after the session starts, and a call can fail on a blip: retry soon a few times.
function retrySoon($) {
  if (quickRetries >= QUICK_RETRY_MAX) return
  quickRetries += 1
  $.clock.after(QUICK_RETRY_MS, () => poll($))
}

async function fetchList($) {
  const r = await callTool($, 'list_notifications', listArgs(cursor))
  if (!r.ok) {
    $.ui.log(`ainecto list_notifications not read: ${r.error}`, { to: 'debug' })
    return
  }
  const data = r.data ?? {}
  if (data.retryAfterSeconds) {
    retryAt = (await $.clock.now()) + Number(data.retryAfterSeconds) * 1000
    return
  }
  const merged = mergeNotifications(notifications, data.items)
  notifications = merged.items
  if (data.nextCursor) {
    cursor = data.nextCursor
    await storeKey($, 'cursor:' + server, cursor)
  }
  hasMore = Boolean(data.hasMore)
  lastUnread = view ? view.unread : null
  await storeKey($, 'items:' + server, notifications)
  // Toast only for what arrives after this session caught up, not for the backlog it reads first.
  const text = caughtUp ? toastText(merged.fresh) : null
  if (text) $.ui.toast(text)
  if (!hasMore) caughtUp = true
}

async function poll($) {
  if (busy) return
  busy = true
  try {
    if (!(await findServer($))) {
      error = 'AiNecto MCP 연결 없음'
      retrySoon($)
      return
    }
    const r = await callTool($, 'get_my_work_summary', {})
    if (!r.ok) {
      error = '동기화 실패'
      server = null // look the server up again next time (renamed, removed, or not connected yet)
      retrySoon($)
      return
    }
    view = summaryView(r.data)
    error = null
    quickRetries = 0
    const now = await $.clock.now()
    lastSyncAt = now
    if (shouldFetchList({ unread: view.unread, lastUnread, hasMore, now, retryAt })) await fetchList($)
  } finally {
    busy = false
    $.ui.status(statusText(view, error))
    $.ui.invalidate('ui.render')
  }
}

async function markRead($, row) {
  const items = readItems([row.item])
  if (!items.length) return
  const r = await callTool($, 'mark_notifications_read', { items })
  if (!r.ok) {
    $.ui.toast('AiNecto · 읽음 처리 실패: ' + r.error)
    return
  }
  notifications = applyRead(notifications, r.data?.results)
  if (view) view = { ...view, mentions: applyRead(view.mentions, r.data?.results) }
  await storeKey($, 'items:' + server, notifications)
  $.ui.invalidate('ui.render')
  await poll($)
}

async function sendReply($, row, text) {
  const body = String(text ?? '').trim()
  const target = replyTarget(row.item)
  if (!body || !target) return
  const parent = target.cardUuid ? { cardUuid: target.cardUuid } : { documentUuid: target.documentUuid }
  // Replies are one level deep: answer under the thread's top-level comment.
  const listed = await callTool($, 'list_comments', parent)
  const root = listed.ok ? threadRoot(listed.data?.comments, target.commentId) : null
  if (!root) {
    $.ui.toast('AiNecto · 원래 댓글을 찾지 못했습니다' + (listed.ok ? '' : ': ' + listed.error))
    return
  }
  const r = await callTool($, 'create_comments', {
    ...parent,
    items: [{ body, parentCommentId: root, clientMutationId: mutationId(row.id, body) }],
  })
  const result = r.ok ? r.data?.results?.[0] : null
  if (!result?.ok) {
    $.ui.toast('AiNecto · 답글 실패: ' + (result?.error ?? r.error ?? 'unknown'))
    return
  }
  replying = null
  draft = ''
  $.ui.toast('AiNecto · 답글을 달았습니다')
  $.ui.invalidate('ui.render')
}

async function openPane($, byUser) {
  const pane = { id: PANE, title: 'AiNecto' }
  const opened = await $.ui.open(byUser ? { ...pane, focus: true } : pane)
  if (!opened?.isPlaced) {
    $.ui.log(`ainecto pane waits: ${opened?.reason ?? 'unknown'}`, { to: 'debug' })
    if (!byUser) $.ui.toast('AiNecto · /ainecto 로 패널을 엽니다')
  }
}

function clock(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await loadSaved($)
    $.clock.every(POLL_MS, () => poll($))
    $.clock.after(1, () => poll($))
    $.ui.status(statusText(null, null))
    await openPane($, false)
    try {
      await $.command.register({
        name: 'ainecto',
        description: 'AiNecto 패널 열기 (sync: 지금 동기화)',
        argumentHint: '[sync]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`ainecto /ainecto not registered: ${err?.message ?? err}`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'ainecto' }, async ($, e) => {
    if (String(e.args ?? '').trim() === 'sync') {
      await poll($)
      return { text: statusText(view, error) }
    }
    await openPane($, true)
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Link, Input } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')
    const tabs = buildTabs({ view, notifications })
    const rows = tabs[tab] ?? []
    const bodyRows = Number(e.props?.scroll?.bodyRows ?? 20)
    const shown = Math.max(3, Math.floor((bodyRows - 5) / 2))

    const head = error
      ? Text({ color: 'red', children: ['⚠ ' + error + (server ? '' : ' — npx -y ainecto@latest setup 을 실행하세요')] })
      : Text({
          dimColor: true,
          children: [
            (view ? '● 연결됨' : '○ 연결 중') +
              ' · ' + clock(lastSyncAt) + ' 동기화' +
              (view ? ' · 안 읽음 ' + view.unread + (view.unreadCapped ? '+' : '') : ''),
          ],
        })

    const counts = {
      notifications: view ? view.unread : 0,
      comments: tabs.comments.filter((r) => r.unread).length,
      work: view ? view.cardCounts.assignedOpen : 0,
    }
    const tabRow = Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        ...TABS.map(([id, label, hotkey]) =>
          Button({
            key: 'tab-' + id,
            label: label + ' ' + counts[id],
            hotkey,
            plain: true,
            dimColor: tab !== id,
            onPress: () => {
              tab = id
              replying = null
              redraw()
            },
          }),
        ),
        Button({ key: 'sync', label: '동기화', hotkey: 's', plain: true, dimColor: true, onPress: () => poll($) }),
      ],
    })

    const rowView = (row) =>
      Box({
        key: 'row-' + row.key,
        flexDirection: 'column',
        children: [
          Text({ wrap: 'truncate-end', bold: row.unread, children: [(row.unread ? '● ' : '○ ') + row.title] }),
          Box({
            flexDirection: 'row',
            columnGap: 2,
            paddingLeft: 2,
            children: [
              Text({ dimColor: true, wrap: 'truncate-end', children: [row.detail || ' '] }),
              ...(row.url ? [Link({ href: row.url, label: '열기' })] : []),
              ...(row.actions.includes('read')
                ? [Button({ key: 'read-' + row.key, label: '확인', plain: true, onPress: () => markRead($, row) })]
                : []),
              ...(row.actions.includes('reply')
                ? [
                    Button({
                      key: 'reply-' + row.key,
                      label: '답하기',
                      plain: true,
                      onPress: () => {
                        replying = row
                        draft = ''
                        redraw()
                      },
                    }),
                  ]
                : []),
            ],
          }),
        ],
      })

    const replyBox = replying
      ? [
          Text({ dimColor: true, wrap: 'truncate-end', children: ['↳ ' + replying.title] }),
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Input({
                key: 'reply-input',
                label: '답글',
                placeholder: '입력 후 Enter',
                value: draft,
                submitLabel: '보내기',
                autoFocus: true,
                onInput: (v) => {
                  draft = v
                },
                onSubmit: (v) => sendReply($, replying, v),
              }),
              Button({
                key: 'reply-cancel',
                label: '취소',
                plain: true,
                onPress: () => {
                  replying = null
                  redraw()
                },
              }),
            ],
          }),
        ]
      : []

    const empty = view ? '표시할 항목이 없습니다' : '불러오는 중…'
    const body = rows.length ? rows.slice(0, shown).map(rowView) : [Text({ dimColor: true, children: [empty] })]
    const more = rows.length > shown ? [Text({ dimColor: true, children: ['외 ' + (rows.length - shown) + '건'] })] : []
    const workHead =
      tab === 'work' && view
        ? [
            Text({
              dimColor: true,
              children: [
                '수락 대기 ' + view.cardCounts.pendingAcceptance +
                  ' · 진행 ' + view.cardCounts.inProgress +
                  ' · 검토 ' + view.cardCounts.inReview +
                  ' · 막힘 ' + view.cardCounts.blocked,
              ],
            }),
          ]
        : []

    return Box({
      flexDirection: 'column',
      children: [
        head,
        tabRow,
        ...replyBox,
        ...workHead,
        ...body,
        ...more,
        Text({ dimColor: true, children: ['서버: ' + (server ?? '—')] }),
      ],
    })
  })
}
