import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadListing, renderManifests, diffAgainstDisk } from '../scripts/build-plugin.mjs';
import { validate } from './json-schema-lite.mjs';

const listing = loadListing();
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const schema = (file) => read(`schemas/agent-plugins-1.0.0/${file}`);
const isHttps = (u) => typeof u === 'string' && new URL(u).protocol === 'https:';

test('generated manifests match listing.json (build --check)', () => {
  assert.deepEqual(diffAgainstDisk(), [], 'run `npm run build` after editing plugin-src/listing.json');
});

test('the generator covers exactly the committed manifest set', () => {
  assert.deepEqual(Object.keys(renderManifests(listing)).sort(), [
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
    '.claude-plugin/plugin.json',
    '.mcp.json',
    'gemini-extension.json',
    'mcp.json',
    'plugin.json',
    'plugins/ainecto-panel/.claude-plugin/plugin.json',
  ]);
});

test('plugin.json passes the official Agent Plugins 1.0.0 schema', () => {
  assert.deepEqual(validate(schema('plugin.schema.json'), read('plugin.json')), []);
});

test('mcp.json passes the official Agent Plugins 1.0.0 MCP schema', () => {
  assert.deepEqual(validate(schema('mcp.schema.json'), read('mcp.json')), []);
});

test('the schema checker rejects broken manifests (negative control)', () => {
  const bad = { ...read('plugin.json'), name: 'Not Kebab', unknownField: 1 };
  assert.ok(validate(schema('plugin.schema.json'), bad).length >= 2);
  const badMcp = { $schema: read('mcp.json').$schema, mcpServers: { x: { type: 'http', url: 'https://a' } } };
  assert.ok(validate(schema('mcp.schema.json'), badMcp).length >= 1);
});

test('listing values satisfy platform limits', () => {
  assert.match(listing.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(listing.name.length <= 64);
  assert.ok(!/^(claude|anthropic)/.test(listing.name), 'Claude reserves claude-/anthropic- names');
  assert.match(listing.version, /^\d+\.\d+\.\d+$/);
  assert.ok([...listing.displayName].length <= 30, 'OpenAI display name: 30 characters');
  assert.ok([...listing.shortDescription].length <= 30, 'OpenAI short description: 30 characters');
  assert.ok([...listing.longDescription].length <= 4000, 'OpenAI long description: 4,000 characters');
  assert.ok([...listing.developer.name].length <= 80, 'OpenAI developer name: 80 characters');
  for (const [key, url] of Object.entries(listing.urls)) assert.ok(isHttps(url), `urls.${key} must be https`);
  assert.ok(isHttps(listing.mcp.url));
  assert.ok(isHttps(listing.homepage));
});

test('icon is a square PNG of at least 512px inside the plugin', () => {
  const abs = join(ROOT, listing.icon);
  assert.ok(listing.icon.startsWith('./assets/'));
  assert.ok(existsSync(abs));
  const buf = readFileSync(abs);
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  assert.equal(w, h);
  assert.ok(w >= 512);
});

test('Claude manifests have the fields the directory reads', () => {
  const p = read('.claude-plugin/plugin.json');
  for (const k of ['documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl']) assert.ok(isHttps(p[k]), k);
  assert.ok(existsSync(join(ROOT, p.icon)));
  assert.ok(p.author?.name);
  const m = read('.claude-plugin/marketplace.json');
  assert.ok(m.name && m.owner?.name && Array.isArray(m.plugins));
  assert.equal(m.plugins[0].name, p.name);
  assert.equal(m.plugins[0].source, './');
  assert.deepEqual(m.plugins.map((x) => x.name), [listing.name, listing.panel.name]);
  const mcp = read('.mcp.json').mcpServers[listing.mcp.serverName];
  assert.deepEqual(mcp, { type: 'http', url: listing.mcp.url });
  assert.ok(!existsSync(join(ROOT, 'bin')), 'claude.ai and Cowork refuse plugins with a root bin/');
});

test('Gemini extension manifest uses httpUrl (Streamable HTTP)', () => {
  const g = read('gemini-extension.json');
  assert.equal(g.name, listing.name);
  assert.equal(g.version, listing.version);
  assert.ok(g.description);
  assert.deepEqual(g.mcpServers[listing.mcp.serverName], { httpUrl: listing.mcp.url });
});

test('Codex marketplace points at this plugin', () => {
  const m = read('.agents/plugins/marketplace.json');
  assert.ok(m.name && m.interface?.displayName);
  const [entry] = m.plugins;
  assert.equal(entry.name, listing.name);
  assert.deepEqual(entry.source, { source: 'local', path: './' });
  assert.deepEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  const ui = read('plugin.json').extensions['com.openai'].interface;
  for (const k of ['composerIcon', 'logo']) assert.ok(ui[k].startsWith('./') && existsSync(join(ROOT, ui[k])), k);
  for (const k of ['websiteURL', 'privacyPolicyURL', 'termsOfServiceURL']) assert.ok(isHttps(ui[k]), k);
});

test('README install commands use the listing values', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const repo = new URL(listing.repository).pathname.slice(1);
  const pluginRef = `${listing.name}@${listing.marketplace.name}`;
  const deeplinkConfig = Buffer.from(JSON.stringify({ url: listing.mcp.url })).toString('base64');
  for (const needle of [
    listing.mcp.url,
    `claude plugin marketplace add ${repo}`,
    `claude plugin install ${pluginRef}`,
    `codex plugin marketplace add ${repo}`,
    `codex plugin add ${pluginRef}`,
    `gemini extensions install ${listing.repository}`,
    `cursor://anysphere.cursor-deeplink/mcp/install?name=${listing.mcp.serverName}&config=${deeplinkConfig}`,
    listing.urls.privacyPolicy,
    listing.urls.termsOfService,
    listing.urls.support,
  ]) {
    assert.ok(readme.includes(needle), `README.md should contain: ${needle}`);
  }
});

test('the Claude Code pane plugin: its own manifest, a hooks module, listed in the Claude marketplace only', () => {
  const panel = listing.panel;
  const dir = panel.path.slice(2);
  assert.match(panel.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(!/^(claude|anthropic)/.test(panel.name));
  assert.notEqual(panel.name, listing.name, 'a mod tool is mcp__<plugin>__*: the name must not be the MCP server name');
  assert.match(panel.version, /^\d+\.\d+\.\d+$/);
  const p = read(`${dir}/.claude-plugin/plugin.json`);
  assert.equal(p.name, panel.name);
  assert.equal(p.version, panel.version);
  assert.ok(!('mcpServers' in p), 'the pane uses the connection the user already has');
  const hooks = read(`${dir}/hooks/hooks.json`);
  assert.equal(hooks.modules.length, 1);
  assert.ok(existsSync(join(ROOT, dir, 'hooks', hooks.modules[0])));
  const entry = read('.claude-plugin/marketplace.json').plugins.find((x) => x.name === panel.name);
  assert.deepEqual(entry, { name: panel.name, source: panel.path, description: panel.description, version: panel.version });
  assert.ok(!read('.agents/plugins/marketplace.json').plugins.some((x) => x.name === panel.name), 'mods run only in Claude Code');
});
