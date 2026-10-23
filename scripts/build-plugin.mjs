#!/usr/bin/env node
// Generates every platform manifest from plugin-src/listing.json (the only place values live).
//   node scripts/build-plugin.mjs           write the manifests
//   node scripts/build-plugin.mjs --check   exit 1 if a committed manifest differs from what would be generated
// Do not edit the generated files by hand: change listing.json and run this script.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LISTING_PATH = 'plugin-src/listing.json';

const AGENT_PLUGINS = 'https://agent-plugins.org/schemas/1.0.0';

export function loadListing(root = ROOT) {
  return JSON.parse(readFileSync(join(root, LISTING_PATH), 'utf8'));
}

/** Pure: listing -> { relativePath: manifestObject }. */
export function renderManifests(l) {
  const author = { name: l.developer.name, email: l.developer.email, url: l.developer.url };
  const server = l.mcp.serverName;

  return {
    // Agent Plugins 1.0 (Codex, ChatGPT, Cursor and other Agent Plugins clients)
    'plugin.json': {
      $schema: `${AGENT_PLUGINS}/plugin.schema.json`,
      name: l.name,
      version: l.version,
      description: l.description,
      author,
      homepage: l.homepage,
      repository: l.repository,
      license: l.license,
      keywords: l.keywords,
      extensions: {
        'com.openai': {
          interface: {
            displayName: l.displayName,
            shortDescription: l.shortDescription,
            longDescription: l.longDescription,
            developerName: l.developer.name,
            category: l.category,
            capabilities: l.capabilities,
            websiteURL: l.urls.website,
            privacyPolicyURL: l.urls.privacyPolicy,
            termsOfServiceURL: l.urls.termsOfService,
            defaultPrompt: l.defaultPrompts,
            composerIcon: l.icon,
            logo: l.icon,
          },
        },
      },
    },
    'mcp.json': {
      $schema: `${AGENT_PLUGINS}/mcp.schema.json`,
      mcpServers: { [server]: { type: 'streamable-http', url: l.mcp.url } },
    },
    // Codex / ChatGPT desktop repo marketplace
    '.agents/plugins/marketplace.json': {
      name: l.marketplace.name,
      interface: { displayName: l.marketplace.displayName },
      plugins: [
        {
          name: l.name,
          source: { source: 'local', path: './' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: l.category,
        },
      ],
    },
    // Claude Code / claude.ai / Cowork
    '.claude-plugin/plugin.json': {
      name: l.name,
      displayName: l.displayName,
      version: l.version,
      description: l.description,
      author,
      homepage: l.homepage,
      repository: l.repository,
      license: l.license,
      keywords: l.keywords,
      icon: l.icon,
      documentationUrl: l.urls.documentation,
      supportUrl: l.urls.support,
      privacyPolicyUrl: l.urls.privacyPolicy,
      termsOfServiceUrl: l.urls.termsOfService,
    },
    '.claude-plugin/marketplace.json': {
      name: l.marketplace.name,
      owner: { name: l.developer.name, email: l.developer.email },
      description: l.description,
      plugins: [{ name: l.name, source: './', description: l.description, version: l.version }],
    },
    '.mcp.json': {
      mcpServers: { [server]: { type: 'http', url: l.mcp.url } },
    },
    // Gemini CLI
    'gemini-extension.json': {
      name: l.name,
      version: l.version,
      description: l.description,
      mcpServers: { [server]: { httpUrl: l.mcp.url } },
    },
  };
}

export function serialize(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

/** Returns the generated paths whose committed content differs (missing counts as different). */
export function diffAgainstDisk(root = ROOT) {
  const files = renderManifests(loadListing(root));
  return Object.entries(files)
    .filter(([rel, obj]) => {
      const abs = join(root, rel);
      return !existsSync(abs) || readFileSync(abs, 'utf8') !== serialize(obj);
    })
    .map(([rel]) => rel);
}

function main(argv) {
  if (argv.includes('--check')) {
    const stale = diffAgainstDisk();
    if (stale.length) {
      console.error(`Generated manifests are out of date (edit ${LISTING_PATH}, then run npm run build):`);
      for (const rel of stale) console.error(`  ${rel}`);
      process.exit(1);
    }
    console.log('Manifests match plugin-src/listing.json.');
    return;
  }
  const files = renderManifests(loadListing());
  for (const [rel, obj] of Object.entries(files)) {
    const abs = join(ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, serialize(obj));
    console.log(`wrote ${rel}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
