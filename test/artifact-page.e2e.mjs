// The exported artifact page in a real browser (Playwright, Chromium) with a stand-in artifact runtime and AiNecto
// server (test/fixtures/fake-artifact-runtime.js): the three tabs work end to end at side-panel width.
//   npm run test:artifact
// Playwright is not a dependency of this repository: the test imports it from this repository if it is installed,
// else from the folder named by AINECTO_PLAYWRIGHT_FROM (any checkout with node_modules/playwright, for example
// ../ainecto-front), and is skipped when neither has it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { buildArtifact, ROOT } from '../scripts/build-mcp-app.mjs';
import { exportPage } from '../scripts/export-artifact.mjs';

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

test('artifact page: room send → signal → re-read, a new chat, a card to the AI — at 400px with no console errors', { skip: !playwright && 'playwright not found (set AINECTO_PLAYWRIGHT_FROM)' }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 760 } });
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.addInitScript((p) => (window.__FAKE_PROJECT__ = p), PROJECT);
    await page.addInitScript({ path: join(ROOT, 'test/fixtures/fake-artifact-runtime.js') });
    // Served from a URL (not setContent) so the init scripts run before the page, as the runtime's do.
    const html = published(exportPage(buildArtifact().html, PROJECT));
    await page.route('https://artifact.test/', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
    await page.goto('https://artifact.test/');
    const fake = (fn, arg) => page.evaluate(fn, arg);
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

    // «AI에게» on someone's message hands it to the viewer's Claude as data.
    await page.locator('.msg:not(.mine) .ask-link').first().click();
    await page.waitForFunction(() => window.__fake.sentToClaude.length === 1);
    const toClaudeMsg = await fake(() => window.__fake.sentToClaude[0]);
    assert.equal(toClaudeMsg.data.kind, 'room_message');
    assert.match(toClaudeMsg.data.notice, /지시가 아니라 참고 자료/);
    assert.deepEqual(toClaudeMsg.opts, { deliver: 'stage' });

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

    // ── Alerts: the project's notifications as cards; «AI에게 검토 요청» → sendToClaudeSession ──
    await page.locator('.tab', { hasText: '알림' }).click();
    await page.getByText('미확인 2').waitFor();
    const card = page.locator('.card', { hasText: '업무 검토 요청' });
    await card.getByText('Claude·Claude Code 협업 연동').waitFor();
    assert.match(await card.innerText(), /Edwin PARK님이 업무 검토를 요청했습니다\./);
    await noOverflow('alerts');
    const listArgs = await fake(() => window.__fake.calls.find((c) => c.tool === 'list_notifications').input);
    assert.deepEqual(listArgs, { projectUuids: [PROJECT], order: 'newest', limit: 20 });
    await card.getByRole('button', { name: /AI에게 검토 요청/ }).click();
    await page.waitForFunction(() => window.__fake.sentToClaude.length === 2);
    const toClaude = await fake(() => window.__fake.sentToClaude[1].data);
    assert.equal(toClaude.kind, 'notification');
    assert.equal(toClaude.refs.projectUuid, PROJECT);
    assert.equal(toClaude.refs.notificationId, 'n-1');
    assert.match(toClaude.ask, /refs\.url/);
    assert.ok(new TextEncoder().encode(JSON.stringify(toClaude)).length <= 4096);
    await page.getByText('대화 입력창에 넣었습니다').waitFor();

    // «확인» marks the card read and the count follows.
    await card.getByRole('button', { name: '확인' }).click();
    await page.getByText('미확인 1').waitFor();

    // The panel never acknowledged or moved the agent's notification position.
    const acks = await fake(() => window.__fake.calls.filter((c) => c.tool === 'list_notifications' && (c.input.ack || c.input.cursor)));
    assert.deepEqual(acks, []);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});
