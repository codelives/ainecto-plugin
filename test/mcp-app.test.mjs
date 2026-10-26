// The panel MCP App (KAN-369): the build is fresh, the copy ainecto-api serves can be checked by hash,
// and the host bridge speaks MCP Apps JSON-RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT,
  OUT_HTML,
  OUT_SHA,
  OUT_ARTIFACT_VERSION,
  artifactVersion,
  build,
  buildArtifact,
  bundle,
  diffAgainstDisk,
  sha256Line,
  toArtifactPage,
  versionSlot,
} from '../scripts/build-mcp-app.mjs';
import { APP_PROTOCOL_VERSION, createBridge, initializeParams } from '../mcp-app/bridge.js';
import { PANEL_TOOLS } from '../mcp-app/panel.js';
import { createArtifactHost, mcpError, pickConnector, roomBridge } from '../mcp-app/artifact-host.js';
import { capabilitiesFor, exportPage } from '../scripts/export-artifact.mjs';
import { contextForClaude, contextText, panelUpdate, POLL_MS, updateRequestForClaude } from '../plugins/ainecto-panel/hooks/inbox.js';

test('the committed panel HTML is a fresh build of its sources (npm run build:app)', () => {
  assert.deepEqual(diffAgainstDisk(), []);
});

test('the .sha256 file names the committed HTML', () => {
  const html = readFileSync(join(ROOT, OUT_HTML), 'utf8');
  assert.equal(readFileSync(join(ROOT, OUT_SHA), 'utf8'), sha256Line(html));
});

test('the panel inlines the Claude Code pane data rules, needs no network, and parses', () => {
  const { html } = build();
  assert.match(html, /^<!-- AiNecto panel MCP App\./);
  assert.ok(html.includes('// ── plugins/ainecto-panel/hooks/inbox.js ──'));
  assert.ok(html.includes(readFileSync(join(ROOT, 'plugins/ainecto-panel/hooks/inbox.js'), 'utf8').split('\n')[0]));
  assert.doesNotMatch(html, /<script[^>]+src=|<link\b|https?:\/\/[^\s"'`)]+\.(js|css)\b/);
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Function(script));
  assert.doesNotMatch(script, /^\s*(import|export)\b/m);
});

test('bundle refuses an import from a module that is not loaded before it', () => {
  assert.throws(() => bundle([['a/x.js', "import { y } from './y.js';\n"]]), /not an earlier module/);
  assert.throws(
    () => bundle([['a/y.js', 'export const z = 1;\n'], ['a/x.js', "import { y } from './y.js';\n"]]),
    /does not export y/,
  );
});

function pair() {
  const sent = [];
  let deliver = null;
  const bridge = createBridge({ post: (m) => sent.push(m), listen: (fn) => (deliver = fn) });
  return { bridge, sent, deliver: (m) => deliver(m) };
}

test('bridge: a request resolves with the host result and rejects with its error', async () => {
  const { bridge, sent, deliver } = pair();
  const ok = bridge.request('tools/call', { name: 'get_my_work_summary', arguments: {} });
  const bad = bridge.request('ui/open-link', { url: 'https://ainecto.com' });
  assert.deepEqual(sent[0], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_my_work_summary', arguments: {} } });
  deliver({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'Link opening denied by user' } });
  deliver({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } });
  assert.deepEqual(await ok, { content: [{ type: 'text', text: '{}' }] });
  await assert.rejects(bad, /ui\/open-link: Link opening denied by user \(-32000\)/);
  assert.equal(bridge.pendingCount(), 0);
});

test('bridge: host notifications reach their handler; host requests are answered', async () => {
  const { bridge, sent, deliver } = pair();
  const seen = [];
  bridge.onNotification('ui/notifications/tool-result', (p) => seen.push(p));
  bridge.onRequest('ui/resource-teardown', () => ({}));
  deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [] } });
  deliver({ jsonrpc: '2.0', id: 'h1', method: 'ui/resource-teardown', params: { reason: 'closed' } });
  deliver({ jsonrpc: '2.0', id: 'h2', method: 'sampling/createMessage', params: {} });
  deliver({ not: 'json-rpc' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [{ content: [] }]);
  assert.deepEqual([...sent].sort((a, b) => String(a.id).localeCompare(String(b.id))), [
    { jsonrpc: '2.0', id: 'h1', result: {} },
    { jsonrpc: '2.0', id: 'h2', error: { code: -32601, message: 'Method not found: sampling/createMessage' } },
  ]);
});

test('ui/initialize params follow McpUiInitializeRequest', () => {
  assert.deepEqual(initializeParams('0.1.0'), {
    appInfo: { name: 'ainecto-panel', version: '0.1.0' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen', 'pip'] },
    protocolVersion: APP_PROTOCOL_VERSION,
  });
  assert.equal(APP_PROTOCOL_VERSION, '2026-01-26');
});

test('PANEL_TOOLS names exactly the tools panel.js calls (the artifact manifest is built from it)', () => {
  const source = readFileSync(join(ROOT, 'mcp-app/panel.js'), 'utf8');
  const called = [...new Set([...source.matchAll(/(?:callTool|subscribe)\('([a-z_]+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual([...PANEL_TOOLS].sort(), called);
});

test('the artifact page is a page body with the same data rules, no MCP Apps bridge and no network', () => {
  const { html } = buildArtifact();
  assert.match(html, /^<!-- AiNecto panel Claude artifact\.[^\n]*-->\n<title>[^<]+<\/title>\n/);
  assert.doesNotMatch(html, /<!doctype|<html\b|<head\b|<body\b|<meta charset|name="viewport"/i);
  assert.ok(html.includes('// ── plugins/ainecto-panel/hooks/inbox.js ──'));
  assert.ok(html.includes('// ── mcp-app/artifact-host.js ──'));
  assert.doesNotMatch(html, /postMessage|ui\/initialize/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link\b|https?:\/\/[^\s"'`)]+\.(js|css)\b/);
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Function(script));
});

test('toArtifactPage keeps title, extra metas, style and the body; drops the skeleton', () => {
  const out = toArtifactPage(
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="x"><title>T</title>' +
      '<meta name="claude:viewport-fit-sides" content="cover"><style>a{}</style></head><body>\n<p>hi</p>\n</body></html>',
  );
  assert.equal(out, '<title>T</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style>a{}</style>\n<p>hi</p>\n');
  assert.throws(() => toArtifactPage('<p>no skeleton</p>'), /no <head> or <body>/);
});

const SUMMARY = { content: [{ type: 'text', text: '{"notifications":{"unread":0}}' }] };
const LISTED = {
  servers: [
    { server: 'artifacts_data', kind: 'artifact', authStatus: 'connected', tools: [{ name: 'get_my_work_summary' }] },
    { server: 'Slack', authStatus: 'connected', tools: [{ name: 'search' }] },
    { server: 'AiNecto dev', authStatus: 'unknown', tools: [{ name: 'get_my_work_summary' }, { name: 'list_notifications' }] },
  ],
};

function fakeClaude({ mcp = undefined, calls = [], caps = {} } = {}) {
  const ns =
    mcp === undefined
      ? {
          listTools: async () => LISTED,
          callTool: async (server, tool, input) => {
            calls.push([server, tool, input]);
            return SUMMARY;
          },
        }
      : mcp;
  return { use: async (name) => (name === 'mcp' ? ns : caps[name] ?? null) };
}

test('artifact host: finds the AiNecto connector from the manifest and calls it with the viewer connection', async () => {
  assert.equal(pickConnector(LISTED.servers), 'AiNecto dev');
  assert.equal(pickConnector([]), null);
  const calls = [];
  const host = createArtifactHost(fakeClaude({ calls }));
  assert.deepEqual(await host.connect(), { name: 'Claude 아티팩트 · AiNecto dev', projectUuid: null, version: null });
  assert.deepEqual(await host.callTool('get_my_work_summary', {}), SUMMARY);
  assert.deepEqual(calls, [['AiNecto dev', 'get_my_work_summary', {}]]);
  assert.equal(host.openLink, undefined);
  assert.equal(host.watch, undefined, 'an older shell without watchTool: the panel reads on its own timer');
  assert.equal(host.sendToClaude, undefined, 'no room: no «AI에게»');
});

test('artifact host: connect fails with the step that fixes it', async () => {
  await assert.rejects(createArtifactHost(undefined).connect(), /Claude 아티팩트 안에서 열어야/);
  await assert.rejects(createArtifactHost(fakeClaude({ mcp: null })).connect(), /커넥터를 부를 수 없습니다/);
  const none = { listTools: async () => ({ servers: [LISTED.servers[1]] }) };
  await assert.rejects(createArtifactHost(fakeClaude({ mcp: none })).connect(), /AiNecto 커넥터를 찾지 못했습니다/);
});

test('artifact host: mcp rejections keep their code; only runtime-stamped ones are retryable', async () => {
  const failing = (err) => ({ listTools: async () => LISTED, callTool: async () => Promise.reject(err) });
  const host = createArtifactHost(fakeClaude({ mcp: failing({ code: 'needs_reauth', server: 'AiNecto dev', message: 'x' }) }));
  await host.connect();
  await assert.rejects(host.callTool('list_notifications', {}), (e) => {
    assert.equal(e.code, 'needs_reauth');
    assert.equal(e.retryable, false);
    assert.match(e.message, /^AiNecto dev 연결이 만료됐습니다/);
    return true;
  });
  const flaky = mcpError({ code: 'server_unavailable', message: 'timeout', retryable: true }, 'AiNecto dev');
  assert.equal(flaky.retryable, true);
  assert.equal(flaky.message, 'server_unavailable: timeout');
  assert.equal(mcpError({ code: 'tool_error', message: 'comment not found' }).message, 'comment not found');
  assert.match(mcpError({ code: 'approval_required' }, 'AiNecto dev').message, /«항상 허용»/);
});

test('artifact host: watchTool keeps reads current at the 30-second floor; invalidate re-reads; old shells refresh the cache', async () => {
  const watched = [];
  const invalidated = [];
  const refreshed = [];
  const mcp = {
    listTools: async () => LISTED,
    callTool: async (server, tool, input, opts) => {
      refreshed.push([tool, opts]);
      return SUMMARY;
    },
    watchTool: (server, tool, input, handler, opts) => {
      watched.push([server, tool, input, opts]);
      handler({ type: 'data', result: SUMMARY });
      handler({ type: 'error', error: { code: 'needs_reauth', server, message: 'x' } });
      return () => watched.push('stopped');
    },
    invalidate: async (server, tool, input) => {
      if (tool === 'list_notifications') throw Object.assign(new Error('unknown method'), { code: 'bad_request' });
      invalidated.push([server, tool, input]);
    },
  };
  const host = createArtifactHost(fakeClaude({ mcp }), { projectUuid: 'p-1', version: 'abc123def456' });
  assert.deepEqual(await host.connect(), { name: 'Claude 아티팩트 · AiNecto dev', projectUuid: 'p-1', version: 'abc123def456' });
  const events = [];
  const stop = host.watch('conversation_list', { projectUuid: 'p-1' }, (ev) => events.push(ev));
  assert.deepEqual(watched[0], ['AiNecto dev', 'conversation_list', { projectUuid: 'p-1' }, { refetchInterval: POLL_MS }]);
  assert.equal(POLL_MS, 30_000);
  assert.deepEqual(events[0], { result: SUMMARY });
  assert.equal(events[1].error.code, 'needs_reauth');
  stop();
  assert.equal(watched.at(-1), 'stopped');
  await host.refresh('conversation_list', { projectUuid: 'p-1' });
  assert.deepEqual(invalidated, [['AiNecto dev', 'conversation_list', { projectUuid: 'p-1' }]]);
  await host.refresh('list_notifications', { order: 'newest' });
  assert.deepEqual(refreshed, [['list_notifications', { cache: { refresh: true } }]]);
});

function fakeRoom() {
  const log = { emitted: [], presence: [], sent: [], listeners: {}, connection: null, peers: null };
  return {
    log,
    emit: async (topic, data) => log.emitted.push([topic, data]),
    on: (topic, fn) => {
      log.listeners[topic] = fn;
      return () => {};
    },
    onConnection: (fn) => {
      log.connection = fn;
      return () => {};
    },
    presence: async (patch) => log.presence.push(patch),
    onPeers: (fn) => {
      log.peers = fn;
      return () => {};
    },
    canSendToClaudeSession: async () => {
      if (log.can instanceof Error) throw log.can;
      return log.can ?? 'available';
    },
    sendToClaudeSession: (data, opts) => {
      log.sent.push([data, opts]);
      const refusal = opts?.deliver === 'send' ? log.refuseSend : log.refuseStage;
      if (refusal) return Promise.reject(Object.assign(new Error('refused'), { code: refusal }));
      return Promise.resolve({ to: 'pane' });
    },
  };
}

test('artifact host: room signals on one topic, connection state passed through, names come from user profiles', async () => {
  const room = fakeRoom();
  const user = { profiles: async (ids) => Object.fromEntries(ids.map((id) => [id, { id, name: id === 'u1' ? 'Edwin' : '' }])) };
  const bridge = roomBridge(room, user);
  await bridge.emit({ c: 'c1', s: 3, k: 'new' });
  assert.deepEqual(room.log.emitted, [['conv', { c: 'c1', s: 3, k: 'new' }]]);
  const heard = [];
  bridge.on((data) => heard.push(data));
  room.log.listeners.conv({ topic: 'conv', data: { c: 'c1', s: 4, k: 'new' }, isMe: false });
  assert.deepEqual(heard, [{ c: 'c1', s: 4, k: 'new' }]);
  const states = [];
  bridge.onConnection((c) => states.push(c));
  room.log.connection(false);
  room.log.connection(true);
  assert.deepEqual(states, [false, true]);
  assert.deepEqual(await bridge.names(['u1', 'u2']), { u1: 'Edwin', u2: '' });
  assert.deepEqual(await roomBridge(room, null).names(['u1']), {});
});

test('artifact host: «AI에게» sends first in every sendable state; claude_unavailable stages in the same press', async () => {
  const room = fakeRoom();
  const host = createArtifactHost(fakeClaude({ caps: { room } }), { projectUuid: 'p-1' });
  await host.connect();
  const ctx = contextForClaude({ projectUuid: 'p-1', message: { seq: 1, uuid: 'm1', author: { displayName: 'Edwin' }, body: 'hi', at: 'x' }, conversation: { conversationUuid: 'c1', type: 'PROJECT_ROOM', name: 'AiNecto' } });
  for (const state of ['available', 'available_if_opened', 'available_if_summoned']) {
    room.log.can = state;
    assert.deepEqual(await host.canSendToClaude(), { ok: true, why: null }, state);
    room.log.sent.length = 0;
    assert.equal(await host.sendToClaude(ctx), 'sent', state);
    assert.deepEqual(room.log.sent, [[ctx, { deliver: 'send' }]], state);
  }
  // A platform that cannot ask: the same call stages.
  room.log.sent.length = 0;
  room.log.refuseSend = 'claude_unavailable';
  assert.equal(await host.sendToClaude(ctx), 'staged');
  assert.deepEqual(room.log.sent.map(([, o]) => o.deliver), ['send', 'stage']);
  // Staging refused too: the panel hears that refusal.
  room.log.refuseStage = 'claude_unavailable';
  await assert.rejects(host.sendToClaude(ctx), { code: 'claude_unavailable' });
  // Any other refusal of the send is not retried as a stage.
  room.log.sent.length = 0;
  room.log.refuseStage = null;
  room.log.refuseSend = 'rate_limited';
  await assert.rejects(host.sendToClaude(ctx), { code: 'rate_limited' });
  assert.deepEqual(room.log.sent.map(([, o]) => o.deliver), ['send']);
});

test('artifact host: a hidden «AI에게» says why', async () => {
  const room = fakeRoom();
  const host = createArtifactHost(fakeClaude({ caps: { room } }), { projectUuid: 'p-1' });
  await host.connect();
  const why = async (can) => {
    room.log.can = can;
    const r = await host.canSendToClaude();
    assert.equal(r.ok, false, String(can));
    return r.why;
  };
  assert.match(await why('no_session'), /Claude 대화 옆에 열었을 때/);
  assert.match(await why('unsupported'), /브라우저/);
  assert.match(await why('off'), /꺼져/);
  assert.match(await why('something_new'), /\(something_new\)/);
  assert.match(await why(Object.assign(new Error('x'), { code: 'capability_removed' })), /capability_removed/);
});

function fakeComments() {
  const log = { can: 'available', sent: [], anchored: [], refuse: null, registered: null, placed: [], exits: 0 };
  return {
    log,
    canSendToClaude: async () => {
      if (log.can instanceof Error) throw log.can;
      return log.can;
    },
    anchorFor: async (el) => {
      log.anchored.push(el);
      return { path: 'article:nth-of-type(1)', x: 0.5, y: 0.5 };
    },
    sendToClaude: (target) => {
      log.sent.push(target);
      if (log.refuse) return Promise.reject(Object.assign(new Error('refused'), { code: log.refuse }));
      return Promise.resolve({ threadId: 't-1', commentId: 'c-1' });
    },
    customAnchors: async (callbacks) => {
      log.registered = callbacks;
      callbacks.threads([{ id: 'h1', anchor: 'x', resolved: false, active: false }]); // before the promise settles
      return { placed: (map) => log.placed.push(map), exitMode: () => (log.exits += 1), release: () => {} };
    },
  };
}

test('artifact host: «AI에게» is one comments.sendToClaude with the short text when comments can send (KAN-392)', async () => {
  const comments = fakeComments();
  const room = fakeRoom();
  const host = createArtifactHost(fakeClaude({ caps: { comments, room } }), { projectUuid: 'p-1' });
  await host.connect();
  const ctx = contextForClaude({ projectUuid: 'p-1', message: { seq: 3, uuid: 'm3', author: { displayName: 'Edwin' }, body: '이거 봐 주세요', at: '2026-10-26T01:00:00Z' }, conversation: { conversationUuid: 'c1', type: 'PROJECT_ROOM', name: 'AiNecto' } });
  assert.deepEqual(await host.canSendToClaude(), { ok: true, why: null });
  const pressed = { tag: 'article' };
  assert.equal(await host.sendToClaude(ctx, pressed), 'commented');
  assert.equal(comments.log.sent.length, 1, 'one call, no dialog');
  assert.deepEqual(comments.log.anchored, [pressed], 'anchored at the pressed item');
  assert.deepEqual(comments.log.sent[0].anchor, { path: 'article:nth-of-type(1)', x: 0.5, y: 0.5 });
  assert.match(comments.log.sent[0].text, /^\[AiNecto 패널\] 프로젝트 룸 — AiNecto\n/);
  assert.match(comments.log.sent[0].text, /^> 이거 봐 주세요$/m);
  assert.deepEqual(room.log.sent, [], 'room is not used');

  // Comment mode: customAnchors registered at connect; every thread list (and the registration) reports placed({}).
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(comments.log.registered);
  assert.deepEqual(comments.log.placed, [{}], 'reported once the controller exists (the early list had none)');
  comments.log.registered.threads([]);
  assert.deepEqual(comments.log.placed, [{}, {}]);
  const modes = [];
  host.onCommentMode((on) => modes.push(on));
  comments.log.registered.mode(true);
  host.exitCommentMode();
  comments.log.registered.mode(false);
  assert.deepEqual(modes, [false, true, false]);
  assert.equal(comments.log.exits, 1);

  // consent_required / rate_limited reach the panel as they are and are not re-sent through room.
  for (const code of ['consent_required', 'rate_limited', 'upstream_error']) {
    comments.log.refuse = code;
    await assert.rejects(host.sendToClaude(ctx, pressed), { code });
  }
  assert.deepEqual(room.log.sent, []);
  // claude_unavailable (nothing was posted): the same press goes through room; comments stays for the next press.
  comments.log.refuse = 'claude_unavailable';
  assert.equal(await host.sendToClaude(ctx, pressed), 'sent');
  assert.deepEqual(room.log.sent, [[ctx, { deliver: 'send' }]]);
  assert.deepEqual(await host.canSendToClaude(), { ok: true, why: null });
  // forbidden is permanent for the view: through room from now on, comments is not asked again.
  comments.log.refuse = 'forbidden';
  room.log.sent.length = 0;
  assert.equal(await host.sendToClaude(ctx, pressed), 'sent');
  const asked = comments.log.sent.length;
  await host.canSendToClaude();
  assert.equal(await host.sendToClaude(ctx, pressed), 'sent');
  assert.equal(comments.log.sent.length, asked, 'comments not asked after forbidden');
});

test('artifact host: comments cannot send here → the same button uses room (KAN-388); without room it says why', async () => {
  const room = fakeRoom();
  for (const can of ['writers_only', 'no_session', 'off', Object.assign(new Error('x'), { code: 'capability_removed' })]) {
    const comments = fakeComments();
    comments.log.can = can;
    const host = createArtifactHost(fakeClaude({ caps: { comments, room } }));
    await host.connect();
    assert.deepEqual(await host.canSendToClaude(), { ok: true, why: null }, String(can));
    room.log.sent.length = 0;
    assert.equal(await host.sendToClaude({ label: 'x' }, {}), 'sent', String(can));
    assert.equal(comments.log.sent.length, 0, String(can));
  }
  const why = async (can) => {
    const comments = fakeComments();
    comments.log.can = can;
    const host = createArtifactHost(fakeClaude({ caps: { comments } }));
    await host.connect();
    const r = await host.canSendToClaude();
    assert.equal(r.ok, false);
    return r.why;
  };
  assert.match(await why('writers_only'), /게시한 사람\(편집자\)만/);
  assert.match(await why('no_session'), /Claude 대화 옆에 열었을 때/);
  assert.match(await why('off'), /꺼져/);
  // customAnchors not declared: registration refused, the panel still runs.
  const comments = fakeComments();
  comments.customAnchors = async () => Promise.reject(Object.assign(new Error('no'), { code: 'not_granted' }));
  const host = createArtifactHost(fakeClaude({ caps: { comments } }));
  await host.connect();
  assert.deepEqual(await host.canSendToClaude(), { ok: true, why: null });
});

test('export: fills the one project slot with a checked uuid; capabilities name the panel tools and the signal topic', () => {
  const html = buildArtifact().html;
  assert.equal(html.split('<script type="application/json" id="ainecto-project">{"projectUuid":null}</script>').length, 2);
  const out = exportPage(html, 'A8B8FEE3-05ED-4383-824D-7E59D7CF66EA');
  assert.ok(out.includes('{"projectUuid":"a8b8fee3-05ed-4383-824d-7e59d7cf66ea"}'));
  assert.equal(out.length - html.length, 'a8b8fee3-05ed-4383-824d-7e59d7cf66ea'.length + 2 - 'null'.length);
  assert.throws(() => exportPage(html, '"></script><script>alert(1)'), /not an AiNecto project uuid/);
  assert.throws(() => exportPage(out, 'a8b8fee3-05ed-4383-824d-7e59d7cf66ea'), /no single empty project slot/);
  assert.deepEqual(capabilitiesFor('claude_ai_Ainecto_dev'), {
    mcp: { servers: [{ server: 'claude_ai_Ainecto_dev', tools: PANEL_TOOLS }] },
    room: { topics: { conv: 'interact' } },
    user: { scopes: ['profile'] },
    comments: { customAnchors: true },
  });
});

test('artifact version (KAN-404): the page hash before its slot, in the page and in the file ainecto-api copies', () => {
  const { html, version } = buildArtifact();
  assert.match(version, /^[0-9a-f]{12}$/);
  const slot = versionSlot(version);
  assert.equal(html.split(slot).length, 2, 'one version slot');
  assert.equal(artifactVersion(html.replace(slot, '')), version, 'the version is the page without its slot');
  assert.equal(readFileSync(join(ROOT, OUT_ARTIFACT_VERSION), 'utf8'), version + '\n');
  // the export fills the project, not the version
  assert.ok(exportPage(html, 'a8b8fee3-05ed-4383-824d-7e59d7cf66ea').includes(slot));
  // any source change moves it
  assert.notEqual(artifactVersion(html.replace(slot, '').replace('<title>', '<title> ')), version);
});

test('panelUpdate: offered only when both are versions and differ', () => {
  assert.deepEqual(panelUpdate('abc123def456', '0123456789ab'), { from: 'abc123def456', to: '0123456789ab' });
  assert.equal(panelUpdate('abc123def456', 'abc123def456'), null);
  assert.equal(panelUpdate('abc123def456', undefined), null);
  assert.equal(panelUpdate(null, '0123456789ab'), null);
  assert.equal(panelUpdate('abc123def456', '<script>'), null);
});

test('updateRequestForClaude: the republish request as the short panel text, nothing quoted', () => {
  const ctx = updateRequestForClaude({ projectUuid: 'p-1', from: 'abc123def456', to: '0123456789ab' });
  assert.deepEqual(ctx.refs, { projectUuid: 'p-1', fromVersion: 'abc123def456', toVersion: '0123456789ab' });
  const text = contextText(ctx);
  assert.match(text, /^\[AiNecto 패널\] 패널 새 버전\n요청: /);
  assert.match(text, /같은 주소에 다시 게시/);
  assert.match(text, /panel\.howToUpdate/);
  assert.match(text, /abc123def456[\s\S]*0123456789ab/);
  assert.doesNotMatch(text, /^> /m);
});
