---
name: report-status
description: Build a status report from AiNecto boards, activity and documents — what got done, what is in progress or in review, what is blocked and what comes next — and save it as a document when asked. Use when the user asks for a status update, progress report, weekly summary, standup notes or "where are we on this project?".
---

# Report status

Collect the facts from AiNecto and turn them into a short, sourced status report.

## When to use

- "Write this week's status report for the payments project."
- "Where are we on the launch board?"
- "Give me standup notes from yesterday's activity."

## Steps

1. **Fix the scope.** Which project or board, and which period. If the user did not say, ask once or
   use the project you are working in and the last seven days, and say so in the report.
2. **Gather the facts.**
   - Cards on the board, per column: `kanban_list_cards(boardUuid)`; page a long column with
     `kanban_list_cards(boardUuid, status, cursor)`. Cards across boards that involve the user:
     `kanban_list_cards(relation, includeDone)`.
   - What happened in the period: `list_history(projectUuid, kinds)` (newest first; needs editor
     access). Page back to the start of the period with `list_history(projectUuid, before)`, passing
     the previous page's `nextCursor`. Use `list_history(resourceType, resourceUuid)` for one card or
     document.
   - What is waiting for the user: `get_my_work_summary(projectUuids)`.
   - The user's own recent notifications, if relevant: `list_notifications(projectUuids)`.
   - Documents changed in the period: `search_documents(projectUuid, updatedFrom, updatedTo)`; read
     the ones that matter with `get_document(uuid)`.
3. **Write the report** with these sections: Done · In progress · In review · Blocked (with who should
   answer) · Next. Cite card keys (for example KAN-15) and links. Use only numbers and facts that came
   from the tool results; mark anything you inferred as such.
4. **Save it only when the user asks.** Create a Markdown document with
   `create_documents(items)` in the project they choose, or add to an existing report document with
   `markdown_append_document(items)`. Give the user the link.

## Tools

| Read | Write (only when asked to save) |
|---|---|
| `kanban_list_cards` · `list_history` · `get_my_work_summary` · `list_notifications` · `search_documents` · `get_document` | `create_documents` · `markdown_append_document` |

## Cautions

- `list_notifications` keeps a saved position per connection: do not pass `ack` or
  `cursor: "latest"` while building a report, or the user's agent may skip items it has not handled.
  Prefer `list_history` for "what happened".
- A board read returns the first page of each column; check `hasMore` before saying a column is
  complete.
- Do not comment on cards or change their status while reporting — use the manage-kanban skill when the
  user asks for changes.
