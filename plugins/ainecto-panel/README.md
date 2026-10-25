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
  on a backlog). That tool allows one call per 30 seconds per connection, and the agent in your session
  shares that connection, so the pane calls it rarely and waits out `retryAfterSeconds`.
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
  when to read the list). The Claude artifact pane is meant to reuse it.
- `hooks/register.js` holds the hooks, the reading loop, and the drawing.
- `.claude-plugin/plugin.json` is generated from `plugin-src/listing.json` (`panel`); do not edit it by hand.
