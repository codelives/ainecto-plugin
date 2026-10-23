---
name: my-work
description: Show what is waiting for the user in AiNecto — unread mentions, questions and to-dos for their agent, and kanban cards assigned to them — and suggest the next action. Use when the user asks "do I have anything to do?", "anything new?", "anything to review?", "did anyone ask me something?" or "what's on my plate in AiNecto?".
---

# My work

See everything that is waiting for the signed-in AiNecto user in one pass, then help them act on it.

## When to use

- The user asks what is new, what to do next, or whether anyone asked them something in AiNecto.
- At the start of a work session, when the user wants a quick catch-up.

## Steps

1. **Summarize.** Call `get_my_work_summary`. When the user names a project, or the project you are
   working in is clear, pass `get_my_work_summary(projectUuids)` to narrow it. The summary is
   read-only: it marks nothing read.
2. **Drill down only where needed.**
   - To-dos for the agent (questions and requests): `list_agent_todos`. A to-do stays on the list
     until it is completed, dismissed, or closed by the person.
   - Cards assigned to the user, including ones not yet accepted: `kanban_list_cards` with no
     arguments, or `kanban_list_cards(relation)` for cards they requested or watch. Read one card in
     full, with what you may do now (`allowedActions`), with `kanban_list_cards(cardUuids)` or
     `kanban_list_cards(cardKeys)` when you only have a key such as KAN-15.
   - Mentions and other notifications: `list_notifications(directOnly)` for items that point at the
     user directly.
   - The document behind an item: `get_document(uuid)` with the target uuid.
   - "Me" (the user's own userId and display name): `identity_get_self`.
3. **Report.** Group the result: questions and mentions waiting for an answer, cards waiting for
   acceptance, cards in progress or in review, blocked cards. Give each item its title and link, and
   end with one suggested next action.
4. **Act only when the user asks.**
   - Work on a to-do: claim it with `update_agent_todos(items)` (`action: "claim"`, keep the
     `leaseToken`), do the work, then complete it with a one-line note (`action: "complete"`).
     Stop if the result says `CLOSED_BY_HUMAN` or `SUPERSEDED`.
   - Card to-dos are closed by doing the card action, not by `update_agent_todos` (it answers
     `BUSINESS_ACTION_REQUIRED`). Accept or decline an assignment with
     `kanban_card_action(cardUuid, action)`.
   - Mark notifications read only when the user explicitly asks: `mark_notifications_read(items)`
     with the `id` and `seq` of each item as you received them.

## Tools

| Read | Write (only on request) |
|---|---|
| `get_my_work_summary` · `list_agent_todos` · `list_notifications` · `kanban_list_cards` · `get_document` · `identity_get_self` | `update_agent_todos` · `mark_notifications_read` · `kanban_card_action` |

## Cautions

- Reading is not acknowledging: `list_notifications` returns the same batch again until you pass its
  `ackToken` back as `list_notifications(ack)`. Calls closer than 30 seconds apart return
  `retryAfterSeconds` instead of items, so do not poll in a tight loop.
- Assigning, approving or answering on someone else's behalf affects other people. Show the user what
  will happen and get their confirmation first.
- Never mark notifications read, dismiss to-dos or decline cards just to "clear the list".
