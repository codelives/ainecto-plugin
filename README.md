# AiNecto plugin

[AiNecto](https://ainecto.com) is shared project memory for people and AI agents: workspaces,
documents, ERDs, diagrams and kanban boards. This plugin connects your AI agent to the AiNecto MCP
server (`https://ainecto.com/mcp`, sign-in with your AiNecto account over OAuth) and adds five skills
that tell the agent how to use it well.

One source, five platforms: Claude (Claude Code, claude.ai, Cowork), OpenAI Codex, ChatGPT, Cursor
and Gemini CLI.

## Skills

| Skill | What it does |
|---|---|
| `my-work` | Shows what is waiting for you — mentions, questions and to-dos for your agent, assigned kanban cards — and suggests the next action. |
| `review-docs` | Finds a document, reads it with its versions, activity and comments, and leaves review comments or questions. |
| `manage-kanban` | Creates and updates cards, checks acceptance criteria, links deliverables and moves cards through their workflow. |
| `create-project` | Sets up a workspace or project with its folders and first documents, without creating duplicates. |
| `report-status` | Builds a sourced status report (done, in progress, in review, blocked, next) and saves it as a document when asked. |

The agent asks before actions that affect other people (assigning, approving, resolving questions) and
changes document bodies only when you ask. What it may change is always limited by your AiNecto
permissions — the server refuses the rest.

## Install

After installing, sign in to AiNecto in the browser the first time the agent connects.

### Claude Code

```bash
claude plugin marketplace add codelives/ainecto-plugin
claude plugin install ainecto@ainecto
```

Then run `/mcp` in a session and sign in to `ainecto` if it asks.

### claude.ai and Cowork

Open **Customize › Plugins** and add the plugin (a paid plan is required to upload a plugin). In
claude.ai chat, connect AiNecto from the plugin's **Connectors** tab. A plugin installed from the
Claude directory is also available in Claude Code.

### OpenAI Codex

```bash
codex plugin marketplace add codelives/ainecto-plugin
codex plugin add ainecto@ainecto
```

### ChatGPT

Once the plugin is published, install **AiNecto** from the ChatGPT Plugins directory (the same
directory Codex uses). Until then you can connect the server directly: **Plugins › + › Add custom MCP
server**, URL `https://ainecto.com/mcp`.

### Cursor

Once the plugin is published, install **AiNecto** from the Cursor Marketplace. To try it locally, clone
this repository into `~/.cursor/plugins/local/ainecto`. To add only the MCP server, open this link:

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=ainecto&config=eyJ1cmwiOiJodHRwczovL2FpbmVjdG8uY29tL21jcCJ9
```

### Gemini CLI

```bash
gemini extensions install https://github.com/codelives/ainecto-plugin
```

Then run `/mcp auth ainecto` in Gemini CLI if it asks you to sign in.

### Already connected with `npx ainecto setup`?

The [AiNecto CLI](https://github.com/codelives/ainecto) `setup` command registers the same server under
the same name, `ainecto`. Use one or the other: either keep `setup` and skip the plugin, or remove the
CLI's entries with `npx -y ainecto@latest setup --undo` before installing the plugin.

## Privacy, terms and support

- Privacy policy: https://ainecto.com/en/privacy/
- Terms of service: https://ainecto.com/en/terms/
- Support: https://ainecto.com/contact/ (contact@codelive.co.kr)

The plugin runs no code on your machine — it holds only skill instructions and the address
of the AiNecto MCP server. Your agent talks to AiNecto with the account you sign in with; AiNecto
handles that data under the privacy policy above.

## Repository layout

```text
plugin-src/listing.json            the single source of every listing value (name, description, URLs, icon, MCP address, version)
plugin-src/tools-snapshot.json     the AiNecto MCP tool names and arguments the skills may mention
skills/<name>/SKILL.md             the five skills (Agent Skills format), shared by every platform
assets/icon.png                    512×512 icon
plugin.json, mcp.json              generated — Agent Plugins 1.0 (Codex, ChatGPT, Cursor)
.agents/plugins/marketplace.json   generated — Codex marketplace
.claude-plugin/plugin.json         generated — Claude
.claude-plugin/marketplace.json    generated — Claude marketplace
.mcp.json                          generated — Claude
gemini-extension.json              generated — Gemini CLI
scripts/build-plugin.mjs           the generator
schemas/agent-plugins-1.0.0/       the official Agent Plugins schemas, vendored for the tests
```

## Development

Requires Node.js 20 or later; there are no dependencies to install.

```bash
npm run build      # regenerate every manifest from plugin-src/listing.json
npm test           # build --check, manifest schema checks, and skill checks
```

Never edit a generated manifest by hand: change `plugin-src/listing.json` and run `npm run build`.
`npm test` fails when a committed manifest differs from what the generator produces.

The skill checks fail when a skill names a tool, or a tool argument, that the AiNecto server does not
have. A tool reference is a backticked snake_case name, optionally with arguments:
`kanban_list_cards(boardUuid, status)`. To refresh the tool list:

```bash
npx -y ainecto@latest tools list --json > tools.json
npm run snapshot-tools -- tools.json
```

Claude's own validator: `claude plugin validate .claude-plugin/plugin.json --strict`.

## License

UNLICENSED — Copyright © 2026 Codelive, Inc. All rights reserved.
