#!/usr/bin/env node
// Copies the built panel MCP App into an ainecto-api checkout, which serves it as the MCP resource
// ui://ainecto/panel (KAN-369). The HTML's source of truth is this repository; ainecto-api only holds a copy.
//   node scripts/copy-mcp-app.mjs <ainecto-api checkout>
// Refuses when the build here is stale. Copies the HTML and its .sha256; ainecto-api's
// McpAppResourcesTest fails when the two stop matching (an edit made there by hand).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, OUT_HTML, OUT_SHA, diffAgainstDisk } from './build-mcp-app.mjs';

/** Where ainecto-api keeps the copy (its classpath resource folder). */
export const API_DIR = 'src/main/resources/mcp-apps';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/copy-mcp-app.mjs <ainecto-api checkout>');
  process.exit(2);
}
const api = resolve(target);
if (!existsSync(join(api, 'pom.xml')) || !existsSync(join(api, 'src/main/java/com/ainecto/api'))) {
  console.error(`${api} is not an ainecto-api checkout`);
  process.exit(2);
}
const stale = diffAgainstDisk();
if (stale.length) {
  console.error(`stale build: ${stale.join(', ')} — run npm run build:app first`);
  process.exit(1);
}
mkdirSync(join(api, API_DIR), { recursive: true });
for (const rel of [OUT_HTML, OUT_SHA]) {
  const name = rel.split('/').pop();
  copyFileSync(join(ROOT, rel), join(api, API_DIR, name));
  console.log(`copied ${rel} → ${join(API_DIR, name)}`);
}
let commit = '(not a git checkout)';
try {
  commit = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', 'mcp-app', 'plugins/ainecto-panel/hooks'], {
    encoding: 'utf8',
  }).trim();
  if (dirty) commit += ' + uncommitted changes';
} catch {
  // not a git checkout: say so in the line below
}
console.log(`ainecto-plugin ${commit} — name it in the ainecto-api commit message`);
