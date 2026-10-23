import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../scripts/build-plugin.mjs';
import { SNAPSHOT_PATH } from '../scripts/snapshot-tools.mjs';

const SKILLS = ['create-project', 'manage-kanban', 'my-work', 'report-status', 'review-docs'];
const snapshot = JSON.parse(readFileSync(join(ROOT, SNAPSHOT_PATH), 'utf8'));
const tools = new Map(snapshot.tools.map((t) => [t.name, t]));

// A backticked span that is exactly a snake_case identifier — optionally followed by (arg, arg) — is a
// tool reference: `kanban_list_cards` or `kanban_list_cards(boardUuid, status)`. Write enum values
// that look like identifiers with quotes or a key (`action: "quick_done"`) so they are not tool names.
const TOOL_REF = /`([a-z]+(?:_[a-z]+)+)(?:\(([^)`]*)\))?`/g;

export function toolRefs(markdown) {
  return [...markdown.matchAll(TOOL_REF)].map(([, name, args]) => ({
    name,
    args: args ? args.split(',').map((a) => a.trim()).filter(Boolean) : [],
  }));
}

function parseSkill(dir) {
  const text = readFileSync(join(ROOT, 'skills', dir, 'SKILL.md'), 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${dir}: SKILL.md must start with YAML frontmatter`);
  const front = Object.fromEntries(
    m[1].split('\n').filter(Boolean).map((line) => {
      const i = line.indexOf(':');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
  );
  return { front, body: m[2], text };
}

test('skills/ holds exactly the five skills', () => {
  const dirs = readdirSync(join(ROOT, 'skills')).filter((d) => statSync(join(ROOT, 'skills', d)).isDirectory());
  assert.deepEqual(dirs.sort(), SKILLS);
});

for (const dir of SKILLS) {
  test(`${dir}: follows the Agent Skills specification`, () => {
    const { front, body } = parseSkill(dir);
    assert.equal(front.name, dir, 'name must equal the folder name');
    assert.match(front.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(front.name.length <= 64);
    assert.ok(front.description && front.description.length <= 1024, 'description: 1..1024 characters');
    assert.ok(body.split('\n').length <= 500, 'body: 500 lines or fewer');
    for (const section of ['## When to use', '## Steps', '## Tools', '## Cautions']) {
      assert.ok(body.includes(section), `missing section ${section}`);
    }
  });

  test(`${dir}: every tool and argument it names exists in the production tool list`, () => {
    const refs = toolRefs(parseSkill(dir).text);
    assert.ok(refs.length > 0, 'a skill must name the tools it uses');
    for (const { name, args } of refs) {
      const tool = tools.get(name);
      assert.ok(tool, `unknown tool "${name}" (not in ${SNAPSHOT_PATH})`);
      for (const arg of args) assert.ok(tool.args.includes(arg), `tool "${name}" has no argument "${arg}"`);
    }
  });

  test(`${dir}: names tools without a client prefix`, () => {
    assert.ok(!/mcp__/.test(parseSkill(dir).text), 'use the tool name only (clients add their own prefix)');
  });
}

test('the tool reference check catches unknown tools and arguments (negative control)', () => {
  const refs = toolRefs('Use `no_such_tool` and `get_document(nope)` but not `action: "quick_done"`.');
  assert.deepEqual(refs.map((r) => r.name), ['no_such_tool', 'get_document']);
  assert.equal(tools.has('no_such_tool'), false);
  assert.equal(tools.get('get_document').args.includes('nope'), false);
});
