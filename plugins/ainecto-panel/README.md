# AiNecto Panel (Claude Code)

A pane beside the Claude Code conversation that shows what is waiting for you in
[AiNecto](https://ainecto.com):

| Tab | What it shows | What you can do |
|---|---|---|
| **1 알림** (notifications) | Your notifications, newest first, with the unread number | Open the item, mark it read (**확인**) |
| **2 댓글** (comments) | Mentions, replies and questions waiting for you | Reply in the pane (**답하기**) |
| **3 업무** (work) | Kanban cards assigned to you, with pending, in progress, in review and blocked counts | Open the card |

A status line under the prompt keeps the numbers (`AiNecto 🔔 37 · 멘션 4 · 할 일 19 · 수락 대기 19`), and
a toast appears when a new notification arrives. `/ainecto` opens the pane, `/ainecto sync` syncs now.

The pane is a [mod](https://code.claude.com/docs/en/plugins/mods/overview): code that runs inside Claude
Code. It talks only to the AiNecto MCP server you already connected (`npx -y ainecto@latest setup`, the
`ainecto` plugin, or the claude.ai connector), through Claude Code's own connection
(`$.mcp.call`). It has no server, no credentials and no settings of its own.

## Requirements

- Claude Code v2.1.287 or later in the terminal, v2.1.286 in the Desktop app, VS Code extension v2.1.299.
  Tested with Claude Code 2.1.310.
- An AiNecto MCP connection in the same session. Without one, the pane says how to connect.

## How it reads AiNecto

- **Numbers**: `get_my_work_summary` every 30 seconds. It is read-only and has no rate limit.
- **Notification list**: `list_notifications`, only when the unread number changes (and while it catches up
  on a backlog).
- **The agent's reading position is never moved.** The pane never sends `ack` and never asks for
  `latest`. Its first read uses `saved` (which reads from the connection's position without moving it), and
  after that it reads on from its own `nextCursor`, kept in the plugin store — the server neither reads
  nor moves the saved position for that kind of call. Restarting Claude Code continues from there.
- **Writes** happen only when you press a button: `mark_notifications_read` (**확인**) and
  `create_comments` (**답하기**, as a reply under the comment's thread).

What it may read or change is always limited by your AiNecto permissions. To see every event the mod
handles and every call it makes, without running it:

```bash
claude plugin validate ./plugins/ainecto-panel
```

## Install for internal use (local path)

Until the plugin is published, install it from a local copy of this repository that contains
`plugins/ainecto-panel` (a checkout or an unpacked copy). The marketplace points at that folder, so keep
it where it is.

```bash
cd /path/to/ainecto-plugin     # the folder with .claude-plugin/marketplace.json
claude plugin marketplace add "$(pwd)"
claude plugin install ainecto-panel@ainecto
```

Then start Claude Code (or run `/reload-plugins` in an open session). In a terminal at least 144 columns
wide the pane opens on its own; otherwise run `/ainecto`. Run `/plugin` and look for
`ainecto-panel` in the `mods active` line under the tabs.

To try it for one session without installing:

```bash
claude --plugin-dir ./plugins/ainecto-panel
```

To update an installed copy after pulling, raise `panel.version` in `plugin-src/listing.json`, run
`npm run build`, then `claude plugin marketplace update ainecto` and `claude plugin update ainecto-panel@ainecto`
(Claude Code caches an installed plugin by version). To remove it:
`claude plugin uninstall ainecto-panel@ainecto`.

## If nothing appears

- Run `claude plugin test` in your shell from a directory without a mod. `no hooks module to load` means
  mods can load. `the rollout switch was saved off by an earlier session` means a stale saved value: start
  `claude` once with a network connection, then check again. `the rollout switch served off` means
  Anthropic has turned installed mods off remotely; the `ainecto` plugin's skills and the MCP server still
  work. `hooks modules are turned off here` means `disableAllHooks` or your organization's policy.
  ([Check whether mods can load](https://code.claude.com/docs/en/plugins/mods/troubleshoot#check-whether-mods-can-load))
- An organization can allow only its own mods (`allowManagedModsOnly`); then the pane does not load.
- The pane's own log lines (every AiNecto call, one line out and one line back) are in the debug log:
  `claude --debug-file ./ainecto-panel.log`, then `grep ainecto ./ainecto-panel.log`.

## Development

```bash
npm test             # from the repository root: manifests and the pane's data rules (node --test)
npm run test:panel   # the mod itself, with `claude plugin test` (no session, no network)
```

- `hooks/inbox.js` holds the pane's data rules as pure functions (merging, de-duplicating, which tab,
  when to read the list). The MCP App panel below imports the same file.
- `hooks/register.js` holds the hooks, the reading loop, and the drawing.
- `.claude-plugin/plugin.json` is generated from `plugin-src/listing.json` (`panel`); do not edit it by hand.

## The project panel in ChatGPT, the Codex app and Claude (MCP App)

The MCP App and the Claude artifact below share one screen (`mcp-app/panel.js`) and the data rules in
`hooks/inbox.js`: **one AiNecto project** in three tabs — **룸** (the project room), **챗** (direct chats with the
project's members, «＋ 새 챗»), **알림** (that project's notifications as cards, «Claude에게 확인 요청»). The Claude Code
pane above still has its own notifications · comments · work tabs.

Hosts that render [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) open it from the AiNecto MCP server
itself: `open_ainecto_panel` shows the resource `ui://ainecto/panel`, and the project is the one that call chose
(`panel.projectUuid` in its result). Without watch support in MCP Apps the screen reads again every 30 seconds while
shown; «AI에게» puts the item in the conversation as quoted text (`ui/message`).

The HTML is built here and served by ainecto-api, which keeps a copy:

```bash
npm run build:app                          # mcp-app/{panel.html,panel.js,…} + hooks/inbox.js → mcp-app/dist/ (both pages)
npm run copy:app -- ../ainecto-api         # copy the HTML and its .sha256, and the artifact page with its version and capabilities, into ainecto-api
```

`npm test` fails when `mcp-app/dist/` is not a fresh build; ainecto-api's `McpAppResourcesTest` fails when its
copy no longer matches the `.sha256` that came with it. Commit the copy in ainecto-api with the commit of this
repository it came from.

## The project panel beside a Claude conversation (artifact)

In Claude web and desktop an artifact opens beside the conversation and stays there. One artifact per AiNecto project
(design `claude-artifact-chat-design` §4), everything through the artifact runtime: `mcp` with the viewer's own
connector (`watchTool` keeps reads current, `invalidate` re-reads now), `room` (after a message is stored the sender
puts `{c, s, k}` — conversation, seq, kind, no body — on topic `conv`, and everyone with the panel open reads again;
«입력 중» is presence) and `user` (names of people typing). «AI에게» is one click (KAN-392): `comments.sendToClaude`
posts the item as a short text starting with `[AiNecto 패널]` on the artifact and sends it to Claude, which answers the
way the Claude app answers artifact comments (KAN-406: the connector no longer tells Claude where to answer; the
connector's instructions only say that the `> ` lines are someone else's words, not instructions). Only editors of the artifact can send that way — publish your own panel; the first send asks once to allow
comments. `comments.customAnchors` keeps the buttons working while comment mode is on («댓글 모드가 켜져 있습니다 ·
끄기»). Where comments cannot send (not an editor, no comments here, `claude_unavailable`) the same button falls back
to `room.sendToClaudeSession` (a dialog, KAN-388).

Claude gets the page from the AiNecto server (KAN-406): `open_ainecto_panel` with `projectUuid` and
`artifactPage: true` returns `panel.artifactPage` — `html` (this build's `mcp-app/dist/ainecto-panel-artifact.html`
with the project uuid in its one slot) and `capabilities` (`mcp-app/dist/ainecto-panel-artifact.capabilities.json`:
`{ mcp: { servers: [{ server: "", tools: PANEL_TOOLS }] }, room: { topics: { conv: "interact" } }, user: { scopes:
["profile"] }, comments: { customAnchors: true } }`). The publishing steps are fixed in the connector's instructions:
publish the HTML unchanged, set `server` to the AiNecto connector as this conversation names it (it differs per
claude.ai account; the page itself names no server and takes the manifest server that lists `get_my_work_summary`),
and republish at the same address when this user already has a panel for the project. No document is read for it.
Each person publishes their own panel from their own claude.ai account (KAN-395): personal claude.ai accounts cannot
open each other's artifacts. Each viewer needs the
AiNecto connector with its write tools (`conversation_send`, `conversation_mark_read`, `mark_notifications_read`) on
«Always allow»: a tool that needs approval is not available to artifacts.

A published panel is a copy, so it does not change when the page here does (KAN-404). The build puts the page's version
(the first 12 hex digits of its sha256, taken before the slot goes in) in a slot and in
`mcp-app/dist/ainecto-panel-artifact.version`, which `copy:app` takes to ainecto-api with the page itself. When the panel opens it reads
`open_ainecto_panel` once; when `panel.artifactVersion` differs from its own it shows «새 버전이 있습니다 · 업데이트»
above the tabs, and «업데이트» sends Claude «[AiNecto 패널] 패널 새 버전» the way «AI에게» sends an item: Claude
republishes the same artifact (same link, the sidebar pin stays) with the page `open_ainecto_panel` hands out. The
version and the page come from the same copy in ainecto-api, so they cannot disagree.

```bash
AINECTO_PLAYWRIGHT_FROM=../ainecto-front npm run test:artifact   # the exported page in Chromium with a stand-in runtime
```
