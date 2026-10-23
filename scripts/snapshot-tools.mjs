#!/usr/bin/env node
// Refreshes plugin-src/tools-snapshot.json — the tool names and argument names the Skills may mention.
//   npx -y ainecto@latest tools list --json > tools.json
//   node scripts/snapshot-tools.mjs tools.json
// Accepts the CLI output ({ ok, data: [...] }) or a raw MCP tools/list result ({ tools: [...] }).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './build-plugin.mjs';

export const SNAPSHOT_PATH = 'plugin-src/tools-snapshot.json';

export function toSnapshot(raw, capturedAt) {
  const tools = Array.isArray(raw?.data) ? raw.data : raw?.tools;
  if (!Array.isArray(tools)) throw new Error('Expected { ok, data: [...] } or { tools: [...] }');
  return {
    source: 'AiNecto MCP tools/list (https://ainecto.com/mcp)',
    capturedAt,
    tools: tools
      .map((t) => ({
        name: t.name,
        args: Object.keys(t.inputSchema?.properties ?? {}),
        readOnly: t.annotations?.readOnlyHint === true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function main([input]) {
  if (!input) {
    console.error('usage: node scripts/snapshot-tools.mjs <tools-list.json>');
    process.exit(2);
  }
  const snap = toSnapshot(JSON.parse(readFileSync(input, 'utf8')), new Date().toISOString().slice(0, 10));
  writeFileSync(join(ROOT, SNAPSHOT_PATH), JSON.stringify(snap, null, 2) + '\n');
  console.log(`wrote ${SNAPSHOT_PATH} (${snap.tools.length} tools)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
