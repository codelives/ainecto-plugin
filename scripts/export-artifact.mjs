#!/usr/bin/env node
// Writes the AiNecto project panel artifact for one project (design claude-artifact-chat-design §4-2): the committed
// build (mcp-app/dist/ainecto-panel-artifact.html) with its project slot filled, and the capabilities to publish it with.
//   node scripts/export-artifact.mjs --project <uuid> --out <page.html> [--server <connector>]
// --server is the AiNecto connector as the publisher's session names it (the Artifact tool resolves it to the
// connector's display name); the page itself names no server — it picks the manifest server that has
// get_my_work_summary. Refuses a stale build and anything but an AiNecto project uuid.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, OUT_ARTIFACT, diffAgainstDisk, projectSlot } from './build-mcp-app.mjs';
import { PANEL_TOOLS } from '../mcp-app/panel.js';
import { projectUuidOf, SIGNAL_TOPIC } from '../plugins/ainecto-panel/hooks/inbox.js';

/** Pure: the committed artifact page → the page for one project. */
export function exportPage(html, projectUuid) {
  const uuid = projectUuidOf(projectUuid);
  if (!uuid) throw new Error(`not an AiNecto project uuid: ${projectUuid}`);
  const empty = projectSlot(null);
  if (html.split(empty).length !== 2) throw new Error('the artifact page has no single empty project slot — rebuild it');
  return html.replace(empty, projectSlot(uuid));
}

/** The capabilities the page needs: the connector's panel tools, the signal topic for Contributors, viewers' names. */
export function capabilitiesFor(server) {
  if (!server) throw new Error('--server is required for the capabilities');
  return {
    mcp: { servers: [{ server, tools: [...PANEL_TOOLS] }] },
    room: { topics: { [SIGNAL_TOPIC]: 'interact' } },
    user: { scopes: ['profile'] },
  };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const project = arg('--project');
  const out = arg('--out');
  const server = arg('--server');
  if (!project || !out) {
    console.error('usage: node scripts/export-artifact.mjs --project <uuid> --out <page.html> [--server <connector>]');
    process.exit(2);
  }
  const stale = diffAgainstDisk();
  if (stale.length) {
    console.error(`stale build: ${stale.join(', ')} — run npm run build:app first`);
    process.exit(1);
  }
  const html = exportPage(readFileSync(join(ROOT, OUT_ARTIFACT), 'utf8'), project);
  writeFileSync(out, html);
  console.log(`wrote ${out} (${html.length} chars) for project ${projectUuidOf(project)}`);
  if (server) {
    const caps = JSON.stringify(capabilitiesFor(server), null, 2);
    const capsPath = out.replace(/\.html?$/i, '') + '.capabilities.json';
    writeFileSync(capsPath, caps + '\n');
    console.log(`wrote ${capsPath}\n${caps}`);
  }
}
