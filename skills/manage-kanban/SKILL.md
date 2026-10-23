---
name: manage-kanban
description: Create, update, assign and move AiNecto kanban cards through their workflow — acceptance criteria, deliverable links, reviews, blocking and card comments. Use when the user asks to add a card or task to a board, change a card, assign it, start it, request review, approve, block or comment on a card (for example "KAN-15").
---

# Manage kanban

Work with cards on AiNecto kanban boards the same way the web app's buttons do.

## When to use

- "Add a card for the login bug to our board and assign it to me."
- "Move KAN-15 to review and link the pull request."
- "Check off the first criterion on KAN-42."

## Steps

1. **Find the board.** A board is a document of type kanban:
   `list_documents(projectUuid, type)` with `type: "kanban"`, or `search_documents(q, type)` when you
   only know its name. If several boards match, ask which one.
2. **Read before you write.**
   - Board columns (To Do, In Progress, In Review, Done): `kanban_list_cards(boardUuid)`; one column
     and further pages with `kanban_list_cards(boardUuid, status, cursor)`.
   - One card in full — description, people, links, `allowedActions`, `revision`:
     `kanban_list_cards(cardUuids)`, or `kanban_list_cards(cardKeys)` when you only have a key such as
     KAN-15. Use the card `uuid` in every write.
3. **Create or edit cards** with one atomic call, `kanban_apply_changes(boardUuid, operations)` (at
   most 100 operations; if one fails, none is applied):
   - `op: "create"` with `title`, and optionally `description` (keep it short; link a document for
     long text), `cardType`, `priority`, `dueAt`, `criteria`, `assigneeUserId`, `reviewerIds`,
     `watcherIds`, `links`, and a `clientMutationId` so a retry does not create a second card.
   - `op: "update"` changes only the fields you send. `criteria` replaces the whole list; the assignee
     may only flip `done`.
   - `op: "link"` / `op: "unlink"` attach or remove a document (`documentUuid`) or an external URL
     (`url`, such as a pull request) with a `linkRole` (`DELIVERABLE`, `REVIEW_RESULT`,
     `TEST_EVIDENCE`, `REQUIREMENT`, `REFERENCE`, `DECISION`).
   - `op: "move"` reorders within a column, or moves the card to another board of the same project
     with `toBoardUuid`.
   - Send `expectedRevision` when other people may be editing the card.
4. **Move the card through its workflow** with `kanban_card_action(cardUuid, action)`. Check the card's
   `allowedActions` first. Actions include `"assign"`, `"accept"`, `"decline"`, `"start"`,
   `"request_review"`, `"approve"`, `"request_changes"`, `"quick_done"`, `"reopen"`, `"block"`,
   `"unblock"`, `"archive"`, `"set_requester"`, `"watch"`. Give a `reason` when the action requires one.
5. **People.** Whoever can read the board can be assigned or mentioned:
   `list_mention_candidates(cardUuid, query)` returns their `userId`.
6. **Card comments.** Read with `list_comments(cardUuid)`; add with `create_comments(cardUuid, items)`.

## Tools

| Read | Write |
|---|---|
| `kanban_list_cards` · `list_documents` · `search_documents` · `list_comments` · `list_mention_candidates` | `kanban_apply_changes` · `kanban_card_action` · `create_comments` |

## Cautions

- Before assigning a card to someone other than the user, approving, or quick-completing a card, show
  the user what will happen and get explicit confirmation — these change other people's work and send
  them notifications.
- Column changes go through `kanban_card_action`, not `kanban_apply_changes`.
- A `CARD_CHANGED` error means someone else edited the card: read it again and redo the change on the
  current version.
- Always give the user the card key and link after a change.
