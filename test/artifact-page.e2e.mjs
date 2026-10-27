// The artifact page (its project slot filled) in a real browser (Playwright, Chromium) with a stand-in artifact runtime and AiNecto
// server (test/fixtures/fake-artifact-runtime.js): the three tabs work end to end at side-panel width.
//   npm run test:artifact
// Playwright is not a dependency of this repository: the test imports it from this repository if it is installed,
// else from the folder named by AINECTO_PLAYWRIGHT_FROM (any checkout with node_modules/playwright, for example
// ../ainecto-front), and is skipped when neither has it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { buildArtifact, projectSlot, ROOT } from '../scripts/build-mcp-app.mjs';

const PROJECT = 'a8b8fee3-05ed-4383-824d-7e59d7cf66ea';
const WIDTH = 400;

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const from = process.env.AINECTO_PLAYWRIGHT_FROM;
    if (!from) return null;
    try {
      return createRequire(join(from, 'package.json'))('playwright');
    } catch {
      return null;
    }
  }
}

/** The page as the Artifact tool publishes it: its skeleton around the exported body. */
function published(body) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}' +
    'body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>' +
    `</head><body>${body}</body></html>`
  );
}

const playwright = await loadPlaywright();

/** The exported page in a Chromium page (400px unless `width`) with the stand-in runtime; `problems` collects console errors. */
async function openPanel(browser, { clock = false, canSend = 'available', comments = null, width = WIDTH, latest = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 760 } });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  if (clock) await page.clock.install();
  await page.addInitScript(
    ([p, c, m, v]) => ((window.__FAKE_PROJECT__ = p), (window.__FAKE_CAN_SEND__ = c), (window.__FAKE_COMMENTS__ = m), (window.__FAKE_LATEST_VERSION__ = v)),
    [PROJECT, canSend, comments, latest],
  );
  await page.addInitScript({ path: join(ROOT, 'test/fixtures/fake-artifact-runtime.js') });
  // Served from a URL (not setContent) so the init scripts run before the page, as the runtime's do.
  // The project slot filled as ainecto-api fills it for open_ainecto_panel (KAN-406).
  const html = published(buildArtifact().html.replace(projectSlot(null), projectSlot(PROJECT)));
  await page.route('https://artifact.test/', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('https://artifact.test/');
  return { page, problems, fake: (fn, arg) => page.evaluate(fn, arg) };
}

const SKIP = !playwright && 'playwright not found (set AINECTO_PLAYWRIGHT_FROM)';

test('artifact page: room send → signal → re-read, a new chat, a card to the AI — at 400px with no console errors', { skip: SKIP }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, problems, fake } = await openPanel(browser);
    const noOverflow = async (where) => {
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(w <= WIDTH, `${where}: page is ${w}px wide at ${WIDTH}px`);
    };

    // ── Room: the project room opens with its messages; my message shows «읽음 N» ──
    await page.getByText('패널 1단계에 착수했습니다.').waitFor();
    await page.getByText('읽음 1').waitFor();
    assert.equal(await page.locator('.tab.active').innerText(), '룸');
    assert.match(await page.locator('#conv-head').innerText(), /테스트 프로젝트[\s\S]*프로젝트 룸 · 멤버 2명/);
    assert.match(await page.locator('#foot').innerText(), /라이언/);
    // The room was on screen with an unread message: the read position moved.
    await page.waitForFunction(() => window.__fake.calls.some((c) => c.tool === 'conversation_mark_read'));
    // Every read is a watch at the 30-second floor; no write is watched.
    const watched = await fake(() => window.__fake.calls.filter((c) => c.watch).map((c) => [c.tool, c.watch.refetchInterval]));
    assert.deepEqual(watched.map(([t]) => t).sort(), ['conversation_get_messages', 'conversation_list', 'get_my_work_summary', 'list_notifications']);
    assert.ok(watched.every(([, ms]) => ms === 30_000));
    await noOverflow('room');

    // Send: stored through conversation_send with an idempotency key, then a body-less signal on the room.
    await page.locator('#compose-input').fill('검토 의견 정리했습니다');
    await page.locator('#compose-send').click();
    await page.locator('.msg.mine .bubble', { hasText: '검토 의견 정리했습니다' }).waitFor();
    const sent = await fake(() => window.__fake.calls.find((c) => c.tool === 'conversation_send'));
    assert.equal(sent.input.conversationUuid, await fake(() => window.__fake.ROOM));
    assert.equal(sent.input.body, '검토 의견 정리했습니다');
    assert.match(sent.input.clientMutationId, /^ainecto-panel:/);
    const signal = await fake(() => window.__fake.emitted.at(-1));
    assert.deepEqual(signal, { topic: 'conv', data: { c: await fake(() => window.__fake.ROOM), s: 3, k: 'new' } });
    assert.equal(await page.locator('#compose-input').inputValue(), '');

    // While the server has not answered: the text shows at once with a spinner, the input is empty, and a read that
    // already brings the stored message (watch or signal) does not make it two bubbles.
    await fake(() => window.__fake.hold());
    await page.locator('#compose-input').fill('보내는 중 말풍선');
    await page.locator('#compose-send').click();
    const sendingBubble = page.locator('.msg.mine.sending', { hasText: '보내는 중 말풍선' });
    await sendingBubble.locator('.spinner').waitFor();
    assert.equal(await page.locator('#compose-input').inputValue(), '');
    await fake(() => window.__fake.tick());
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.msg.mine', { hasText: '보내는 중 말풍선' }).count(), 1, 'one bubble while sending');
    await noOverflow('room while sending');
    await fake(() => window.__fake.release());
    await sendingBubble.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.msg.mine', { hasText: '보내는 중 말풍선' }).count(), 1);
    assert.equal(await page.locator('.spinner').count(), 0, 'the spinner is gone once stored');

    // A failed send: «다시 보내기» with the same clientMutationId; the server stores it once.
    await fake(() => window.__fake.failNext(1));
    await page.locator('#compose-input').fill('실패 뒤 다시 보내기');
    await page.locator('#compose-input').press('Enter');
    const failed = page.locator('.msg.mine.failed', { hasText: '실패 뒤 다시 보내기' });
    await failed.getByRole('button', { name: '다시 보내기' }).click();
    await failed.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.msg.mine', { hasText: '실패 뒤 다시 보내기' }).count(), 1);
    const tries = await fake(() => window.__fake.calls.filter((c) => c.tool === 'conversation_send' && c.input.body === '실패 뒤 다시 보내기').map((c) => c.input.clientMutationId));
    assert.equal(tries.length, 2);
    assert.equal(tries[0], tries[1], 'the retry reuses the key');
    const storedCount = await fake(() => window.__fake.store.messages[window.__fake.ROOM].filter((m) => m.body === '실패 뒤 다시 보내기').length);
    assert.equal(storedCount, 1);

    // Someone else's message arrives with a signal: read again at once (no 30-second wait).
    await fake(() => {
      const s = window.__fake.serverMessage(window.__fake.ROOM, window.__fake.EDWIN, '확인했습니다. 같이 볼게요.');
      window.__fake.signal({ c: window.__fake.ROOM, s, k: 'new' });
    });
    await page.getByText('확인했습니다. 같이 볼게요.').waitFor({ timeout: 2000 });
    // A message stored elsewhere (CLI, no signal) found by the next watch read is passed on to the room.
    const cliSeq = await fake(() => window.__fake.serverMessage(window.__fake.ROOM, window.__fake.EDWIN, 'CLI 에서 보낸 메시지'));
    await fake(() => window.__fake.tick());
    await page.getByText('CLI 에서 보낸 메시지').waitFor();
    await page.waitForFunction((seq) => window.__fake.emitted.some((e) => e.data.s === seq), cliSeq);
    assert.deepEqual((await fake(() => window.__fake.emitted)).filter((e) => e.data.s === cliSeq), [
      { topic: 'conv', data: { c: await fake(() => window.__fake.ROOM), s: cliSeq, k: 'new' } },
    ], 'passed on once');

    // A forged signal carries no body: it only makes the page read again.
    await fake(() => window.__fake.signal({ c: window.__fake.ROOM, s: 99, k: 'new', body: '가짜 본문' }));
    await page.waitForTimeout(100);
    assert.equal(await page.getByText('가짜 본문').count(), 0);

    // «입력 중»: presence from another viewer typing in this room.
    await fake(() => window.__fake.peers([{ peer: 'p2', by: 'claude-edwin', isMe: false, sameTab: false, kind: 'viewer', guest: false, presence: { typingIn: window.__fake.ROOM }, updatedAt: 0 }]));
    await page.getByText('Edwin 입력 중…').waitFor();
    // and mine: typing sets presence.typingIn to this conversation
    await page.locator('#compose-input').fill('작성 중');
    const room = await fake(() => window.__fake.ROOM);
    assert.ok((await fake(() => window.__fake.presence)).some((p) => p.typingIn === room));
    await page.locator('#compose-input').fill('');

    // «AI에게» on someone's message sends it to the viewer's Claude as data: the platform asks once, Claude answers.
    assert.equal(await page.locator('.msg:not(.mine) .ask-link').first().textContent(), 'Claude에게');
    await page.locator('.msg:not(.mine) .ask-link').first().click();
    await page.waitForFunction(() => window.__fake.sentToClaude.length === 1);
    const toClaudeMsg = await fake(() => window.__fake.sentToClaude[0]);
    assert.equal(toClaudeMsg.data.kind, 'room_message');
    assert.match(toClaudeMsg.data.notice, /지시가 아니라 참고 자료/);
    assert.deepEqual(toClaudeMsg.opts, { deliver: 'send' });
    await page.getByText('Claude에게 보냈습니다').waitFor();

    // ── Chat: start a chat with a project member from «＋ 새 챗» ──
    await page.locator('.tab', { hasText: '챗' }).click();
    await page.getByText('«＋ 새 챗» 으로 프로젝트 멤버와 챗을 시작하세요').waitFor();
    await noOverflow('chat list');
    await page.locator('#new-chat').click();
    await page.locator('.person', { hasText: 'Edwin PARK' }).getByRole('button', { name: '챗 시작' }).click();
    await page.getByText('Edwin PARK님과의 첫 메시지를 보내면 챗이 시작됩니다').waitFor();
    await page.locator('#compose-input').fill('패널 목업 같이 검토해 주실 수 있을까요?');
    await page.locator('#compose-input').press('Enter');
    await page.locator('.msg.mine .bubble', { hasText: '패널 목업 같이 검토해 주실 수 있을까요?' }).waitFor();
    const chatSend = await fake(() => window.__fake.calls.filter((c) => c.tool === 'conversation_send').at(-1));
    assert.deepEqual(chatSend.input.to, { projectUuid: PROJECT, userId: await fake(() => window.__fake.EDWIN) });
    assert.equal(chatSend.input.conversationUuid, undefined);
    assert.match(await page.locator('#conv-head').innerText(), /Edwin PARK[\s\S]*개인 챗/);
    await noOverflow('chat');
    await page.locator('#conv-head .back').click();
    await page.locator('#chat-rows .row', { hasText: 'Edwin PARK' }).waitFor();

    // ── Alerts: the project's notifications as cards; «Claude에게 확인 요청» → sendToClaudeSession ──
    await page.locator('.tab', { hasText: '알림' }).click();
    await page.getByText('미확인 2').waitFor();
    const card = page.locator('.card', { hasText: '업무 검토 요청' });
    await card.getByText('Claude·Claude Code 협업 연동').waitFor();
    assert.match(await card.innerText(), /Edwin PARK님이 업무 검토를 요청했습니다\./);
    await noOverflow('alerts');
    await card.getByRole('button', { name: /Claude에게 확인 요청/ }).waitFor();
    assert.equal(await card.locator('.hint').count(), 0, 'no hint under the button while it can send (KAN-393)');
    const listArgs = await fake(() => window.__fake.calls.find((c) => c.tool === 'list_notifications').input);
    assert.deepEqual(listArgs, { projectUuids: [PROJECT], order: 'newest', limit: 20 });
    // Where the platform cannot ask (send is claude_unavailable), the same click stages it in the composer.
    await fake(() => window.__fake.refuseSend('claude_unavailable'));
    await card.getByRole('button', { name: /Claude에게 확인 요청/ }).click();
    await page.waitForFunction(() => window.__fake.sentToClaude.length === 2);
    assert.deepEqual(await fake(() => window.__fake.refusedToClaude.map((r) => r.opts)), [{ deliver: 'send' }]);
    assert.deepEqual(await fake(() => window.__fake.sentToClaude[1].opts), { deliver: 'stage' });
    const toClaude = await fake(() => window.__fake.sentToClaude[1].data);
    assert.equal(toClaude.kind, 'notification');
    assert.equal(toClaude.refs.projectUuid, PROJECT);
    assert.equal(toClaude.refs.notificationId, 'n-1');
    assert.match(toClaude.ask, /원문/);
    assert.ok(new TextEncoder().encode(JSON.stringify(toClaude)).length <= 4096);
    await page.getByText('대화 입력창에 넣었습니다').waitFor();

    // «확인» marks the card read and the count follows.
    await card.getByRole('button', { name: '확인', exact: true }).click();
    await page.getByText('미확인 1').waitFor();

    // The panel never acknowledged or moved the agent's notification position.
    const acks = await fake(() => window.__fake.calls.filter((c) => c.tool === 'list_notifications' && (c.input.ack || c.input.cursor)));
    assert.deepEqual(acks, []);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});

test('artifact page: alone, the open room is read every 5 s — stops when someone has it open, when hidden, on rate_limited', { skip: SKIP }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, problems, fake } = await openPanel(browser, { clock: true });
    await page.getByText('패널 1단계에 착수했습니다.').waitFor();
    await page.clock.pauseAt(Date.now() + 1000);
    // reads the pane makes on its own: callTool (not a watch) of the open conversation
    const aloneReads = () => fake(() => window.__fake.calls.filter((c) => c.tool === 'conversation_get_messages' && !c.watch).length);
    const room = await fake(() => window.__fake.ROOM);

    // Alone in the room: one read every 5 s, of the messages after the last one shown.
    let n = await aloneReads();
    await page.clock.runFor(5_000);
    assert.equal(await aloneReads(), n + 1);
    await page.clock.runFor(10_000);
    assert.equal(await aloneReads(), n + 3);
    const last = await fake(() => window.__fake.calls.filter((c) => c.tool === 'conversation_get_messages' && !c.watch).at(-1).input);
    assert.equal(last.conversationUuid, room);
    assert.ok(last.afterSeq >= 2, 'only what came after the last shown message');
    // A message stored elsewhere shows within one tick, no signal needed.
    await fake(() => window.__fake.serverMessage(window.__fake.ROOM, window.__fake.EDWIN, '다른 계정에서 보낸 메시지'));
    await page.clock.runFor(5_000);
    await page.getByText('다른 계정에서 보낸 메시지').waitFor();

    // Someone else opens this room in the artifact: signals take over, the 5-second reads stop.
    const other = { peer: 'p2', by: 'claude-edwin', isMe: false, sameTab: false, kind: 'viewer', guest: false, presence: { viewing: room }, updatedAt: 0 };
    await fake((p) => window.__fake.peers([p]), other);
    n = await aloneReads();
    await page.clock.runFor(20_000);
    assert.equal(await aloneReads(), n, 'no reads alone while someone can signal');
    // They leave: back to reading alone.
    await fake(() => window.__fake.peers([]));
    await page.clock.runFor(5_000);
    assert.equal(await aloneReads(), n + 1);

    // Hidden: stops; visible again: one read at once, then every 5 s.
    const setVisibility = (state) =>
      fake((v) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);
    await setVisibility('hidden');
    n = await aloneReads();
    await page.clock.runFor(20_000);
    assert.equal(await aloneReads(), n, 'no reads while hidden');
    await setVisibility('visible');
    await page.clock.runFor(10);
    assert.equal(await aloneReads(), n + 1, 'one read on return');
    await page.clock.runFor(5_000);
    assert.equal(await aloneReads(), n + 2);

    // rate_limited: the 5-second reads stop for good (the 30-second watch goes on).
    await fake(() => window.__fake.failReads('rate_limited'));
    await page.clock.runFor(5_000);
    n = await aloneReads();
    await fake(() => window.__fake.failReads(null));
    await page.clock.runFor(30_000);
    assert.equal(await aloneReads(), n, 'stopped after rate_limited, never tightened');
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});

test('artifact page: no Claude beside the panel — «AI에게» hidden with the reason, back when a conversation is open', { skip: SKIP }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, problems, fake } = await openPanel(browser, { canSend: 'no_session' });
    const why = 'Claude에게 버튼은 이 패널을 Claude 대화 옆에 열었을 때 나타납니다';
    await page.getByText('패널 1단계에 착수했습니다.').waitFor();
    await page.locator('#banner', { hasText: why }).waitFor();
    assert.equal(await page.locator('.msg .ask-link').count(), 0);
    await page.locator('.tab', { hasText: '알림' }).click();
    const card = page.locator('.card', { hasText: '업무 검토 요청' });
    await card.locator('.hint', { hasText: why }).waitFor();
    assert.equal(await card.getByRole('button', { name: /Claude에게/ }).count(), 0);
    // A conversation opens beside it: the next re-check (a tab change) shows the button again.
    await fake(() => window.__fake.canSend('available'));
    await page.locator('.tab', { hasText: '룸' }).click();
    await page.locator('.tab', { hasText: '알림' }).click();
    await card.getByRole('button', { name: /Claude에게 확인 요청/ }).waitFor();
    assert.equal(await card.locator('.hint', { hasText: why }).count(), 0);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});

test('artifact page: comments can send — «AI에게» is one sendToClaude, works in comment mode, consent_required says so (KAN-392)', { skip: SKIP }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, problems, fake } = await openPanel(browser, { comments: 'available' });
    await page.getByText('패널 1단계에 착수했습니다.').waitFor();
    // customAnchors registered at load and reported an empty placement (pins stay in the shell's list).
    await page.waitForFunction(() => window.__fake.comments.anchors && window.__fake.comments.placed.length > 0);
    assert.deepEqual(await fake(() => window.__fake.comments.placed.at(-1)), {});

    // Room message: one click → one comments.sendToClaude with the short text; no dialog, room not used.
    await page.locator('.msg:not(.mine) .ask-link').first().click();
    await page.waitForFunction(() => window.__fake.comments.sent.length === 1);
    const first = await fake(() => window.__fake.comments.sent[0]);
    assert.equal(first.anchor.path, 'article', 'anchored at the pressed message');
    assert.match(first.text, /^\[AiNecto 패널\] 프로젝트 룸 — 테스트 프로젝트\n보낸 사람: /);
    assert.match(first.text, /^요청: /m);
    assert.deepEqual(await fake(() => window.__fake.sentToClaude), []);
    await page.getByText('답은 댓글 스레드에 옵니다').waitFor();

    // Comment mode on: «댓글 모드가 켜져 있습니다 · 끄기», and the card button still works (the shell does not take the click).
    await fake(() => window.__fake.commentMode(true));
    await page.locator('#comment-mode', { hasText: '댓글 모드가 켜져 있습니다' }).waitFor();
    await page.locator('.tab', { hasText: '알림' }).click();
    const card = page.locator('.card', { hasText: '업무 검토 요청' });
    await card.getByRole('button', { name: /Claude에게 확인 요청/ }).click();
    await page.waitForFunction(() => window.__fake.comments.sent.length === 2);
    const second = await fake(() => window.__fake.comments.sent[1]);
    assert.match(second.text, /^\[AiNecto 패널\] 업무 검토 요청 — Claude·Claude Code 협업 연동\n/);
    assert.match(second.text, /^원문: https?:\/\//m);
    assert.ok(new TextEncoder().encode(second.text).length <= 4096);
    // «끄기» asks the shell to leave comment mode; the strip goes away on mode(false).
    await page.locator('#comment-mode').getByRole('button', { name: '끄기' }).click();
    await page.locator('#comment-mode').waitFor({ state: 'hidden' });
    assert.equal(await fake(() => window.__fake.comments.exits), 1);

    // consent_required: nothing sent through room, the viewer is told what to do.
    await fake(() => window.__fake.refuseComment('consent_required'));
    await card.getByRole('button', { name: /Claude에게 확인 요청/ }).click();
    await page.getByText('처음 한 번 댓글 허용이 필요합니다').waitFor();
    assert.deepEqual(await fake(() => window.__fake.sentToClaude), []);

    // claude_unavailable (nothing posted): the same click falls back to room's send (KAN-388).
    await fake(() => window.__fake.refuseComment('claude_unavailable'));
    await card.getByRole('button', { name: /Claude에게 확인 요청/ }).click();
    await page.waitForFunction(() => window.__fake.sentToClaude.length === 1);
    assert.deepEqual(await fake(() => window.__fake.sentToClaude[0].opts), { deliver: 'send' });
    await page.getByText('확인 창이 뜨면').waitFor();
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});

test('artifact page: comments only for editors — writers_only falls back to room in the same button', { skip: SKIP }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { page, problems, fake } = await openPanel(browser, { comments: 'writers_only' });
    await page.getByText('패널 1단계에 착수했습니다.').waitFor();
    await page.locator('.msg:not(.mine) .ask-link').first().click();
    await page.waitForFunction(() => window.__fake.sentToClaude.length === 1);
    assert.deepEqual(await fake(() => window.__fake.comments.sent), []);
    assert.deepEqual(await fake(() => window.__fake.sentToClaude[0].opts), { deliver: 'send' });
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});

test('artifact page: content stops at 560px and centres in a wide pane, fits a 360px one with no sideways scroll (KAN-403)', { skip: SKIP }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    for (const width of [1200, 360]) {
      const { page, problems } = await openPanel(browser, { width });
      await page.getByText('패널 1단계에 착수했습니다.').waitFor();
      for (const tab of ['룸', '알림', '챗']) {
        await page.locator('.tab', { hasText: tab }).click();
        const box = await page.evaluate(() => {
          const r = document.querySelector('.app').getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width, page: document.documentElement.scrollWidth, view: innerWidth };
        });
        assert.ok(box.page <= width, `${width}px ${tab}: page is ${box.page}px wide`);
        if (width > 560) {
          assert.equal(box.width, 560, `${width}px ${tab}: content is ${box.width}px wide`);
          assert.ok(Math.abs(box.left - (box.view - box.right)) <= 1, `${width}px ${tab}: not centred (${box.left} / ${box.view - box.right})`);
        } else {
          assert.equal(box.width, box.view, `${width}px ${tab}: content ${box.width}px, pane ${box.view}px`);
        }
        if (tab === '알림') {
          const card = await page.locator('.card').first().boundingBox();
          assert.ok(card.width <= 560, `${width}px: card is ${card.width}px wide`);
        }
      }
      assert.deepEqual(problems, []);
      await page.context().close();
    }
  } finally {
    await browser.close();
  }
});

test('artifact page: a newer panel — «새 버전이 있습니다 · 업데이트» sends the republish request; the same version shows nothing (KAN-404)', { skip: SKIP }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const { version } = buildArtifact();
    const versionCall = (fake) => fake(() => window.__fake.calls.find((c) => c.tool === 'open_ainecto_panel'));

    // Same version: asked once with the project, nothing shown.
    {
      const { page, problems, fake } = await openPanel(browser, { latest: version, comments: 'available' });
      await page.getByText('패널 1단계에 착수했습니다.').waitFor();
      await page.waitForFunction(() => window.__fake.calls.some((c) => c.tool === 'open_ainecto_panel'));
      assert.deepEqual((await versionCall(fake)).input, { projectUuid: PROJECT });
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#update').isHidden(), true, 'same version: no update bar');
      assert.deepEqual(problems, []);
      await page.context().close();
    }
    // A server that names no version (older api): nothing shown, no error.
    {
      const { page, problems } = await openPanel(browser, { comments: 'available' });
      await page.getByText('패널 1단계에 착수했습니다.').waitFor();
      await page.waitForFunction(() => window.__fake.calls.some((c) => c.tool === 'open_ainecto_panel'));
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#update').isHidden(), true, 'no version named: no update bar');
      assert.deepEqual(problems, []);
      await page.context().close();
    }
    // Newer version: the bar above the tabs; «업데이트» is one comments.sendToClaude with the republish request.
    {
      const { page, problems, fake } = await openPanel(browser, { latest: '0123456789ab', comments: 'available' });
      const bar = page.locator('#update');
      await bar.getByText('새 버전이 있습니다').waitFor();
      const [barBox, tabsBox] = [await bar.boundingBox(), await page.locator('#tabs').boundingBox()];
      assert.ok(barBox.y < tabsBox.y, 'the bar is above the tabs');
      await bar.getByRole('button', { name: '업데이트' }).click();
      await page.waitForFunction(() => window.__fake.comments.sent.length === 1);
      const sent = await fake(() => window.__fake.comments.sent[0]);
      assert.match(sent.text, /^\[AiNecto 패널\] 패널 새 버전\n요청: /);
      assert.ok(sent.text.includes(version) && sent.text.includes('0123456789ab'));
      assert.match(sent.text, /같은 주소에 다시 게시/);
      await page.getByText('답은 댓글 스레드에 옵니다').waitFor();
      assert.deepEqual(problems, []);
      await page.context().close();
    }
    // Newer version where «AI에게» cannot go: no button, what to tell Claude instead.
    {
      const { page, problems } = await openPanel(browser, { latest: '0123456789ab', canSend: 'no_session' });
      const bar = page.locator('#update');
      await bar.getByText('새 버전이 있습니다').waitFor();
      await bar.getByText('같은 주소에 다시 게시해 줘').waitFor();
      assert.equal(await bar.getByRole('button').count(), 0);
      assert.deepEqual(problems, []);
      await page.context().close();
    }
  } finally {
    await browser.close();
  }
});

// Review #15 F2: more messages than one page land between two reads of the open room. The pane reads the gap page by
// page (hasMore) and marks read only what it read without a hole — not past a hole it failed to fill.
test('artifact page: a burst between two reads — every message shows, read position never passes a hole (review #15 F2)', { skip: SKIP }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const shownBursts = () => [...document.querySelectorAll('#timeline .bubble')].map((e) => e.textContent).filter((t) => t.startsWith('burst-'));
    const marksSince = (from) => window.__fake.calls.slice(from).filter((c) => c.tool === 'conversation_mark_read').map((c) => c.input.throughSeq);
    for (const n of [30, 70, 120]) {
      const { page, problems, fake } = await openPanel(browser);
      await page.waitForFunction(() => window.__fake.calls.some((c) => c.tool === 'conversation_mark_read'));
      const from = await fake(() => window.__fake.calls.length);
      await fake((count) => {
        for (let i = 1; i <= count; i++) window.__fake.serverMessage(window.__fake.ROOM, window.__fake.EDWIN, 'burst-' + i);
        window.__fake.tick();
      }, n);
      await page.waitForFunction((seq) => window.__fake.store.read[window.__fake.ROOM][window.__fake.ME] === seq, 2 + n);
      await fake(() => window.__fake.tick());
      await page.waitForTimeout(100);
      const shown = await page.evaluate(shownBursts);
      const missing = Array.from({ length: n }, (_, i) => 'burst-' + (i + 1)).filter((b) => !shown.includes(b));
      assert.deepEqual(missing, [], `${n}: every message of the burst is shown`);
      const marks = await page.evaluate(marksSince, from);
      assert.ok(marks.length > 0 && marks.every((s, i) => s <= 2 + n && (i === 0 || s > marks[i - 1])), `${n}: marks ${marks}`);
      assert.deepEqual(problems, []);
      await page.context().close();
    }

    // The gap read fails: nothing is marked past the hole; the next read fills it, then the read position moves.
    {
      const { page, problems, fake } = await openPanel(browser);
      await page.waitForFunction(() => window.__fake.calls.some((c) => c.tool === 'conversation_mark_read'));
      const from = await fake(() => window.__fake.calls.length);
      await fake(() => {
        window.__fake.failReads('server_unavailable');
        for (let i = 1; i <= 120; i++) window.__fake.serverMessage(window.__fake.ROOM, window.__fake.EDWIN, 'burst-' + i);
        window.__fake.tick();
      });
      await page.waitForFunction((f) => window.__fake.calls.slice(f).some((c) => c.tool === 'conversation_get_messages' && !c.watch && c.input.afterSeq === 2), from);
      await page.waitForTimeout(200);
      assert.deepEqual((await page.evaluate(marksSince, from)).filter((s) => s > 2), [], 'not marked past the hole');
      assert.equal(await fake(() => window.__fake.store.read[window.__fake.ROOM][window.__fake.ME]), 2);
      await fake(() => {
        window.__fake.failReads(null);
        window.__fake.tick();
      });
      await page.waitForFunction(() => window.__fake.store.read[window.__fake.ROOM][window.__fake.ME] === 122);
      assert.equal((await page.evaluate(shownBursts)).length, 120, 'the hole is filled on the next read');
      assert.deepEqual(problems.filter((p) => !/server_unavailable/.test(p)), []);
      await page.context().close();
    }
  } finally {
    await browser.close();
  }
});
