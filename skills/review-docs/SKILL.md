---
name: review-docs
description: Find an AiNecto document, read it, compare it with earlier versions and its activity, and leave review comments or questions on it. Use when the user asks to find, read, review, compare versions of, or comment on a document in AiNecto (design docs, specs, ERDs, diagrams, OpenAPI, HTML or file documents).
---

# Review documents

Find the right document, read it with its history and existing discussion, and leave useful review
comments — without changing the document itself unless the user asks.

## When to use

- "Review the API design doc and leave comments."
- "What changed in the onboarding spec since last week?"
- "Find Mina's ERD document and ask about the orders table."

## Steps

1. **Find the document.**
   - By keywords, people or dates: `search_documents(q, projectUuid, updatedFrom)`. For "Mina's" or
     "edited by Mina", get the userId first with `list_mention_candidates(query)` (or
     `identity_get_self` for "me"), then filter with `search_documents(ownerUserId)` or
     `search_documents(lastEditorUserId)`.
   - Inside a known project or folder: `list_documents(projectUuid, folderUuid, q)`.
   - Titles can repeat. When several documents match, show folder and project and ask which one.
2. **Read it.** `get_document(uuid)`. Markdown, OpenAPI and HTML return the body; a kanban board
   returns its columns; an ERD returns metadata only.
3. **Compare with earlier versions** when the user asks what changed: `list_versions(documentUuid)`
   (newest first; `locked` versions are outside the plan's history window and cannot be opened), then
   `get_version(documentUuid, versionNumber)` for the version to compare. Who did what recently:
   `list_history(resourceType, resourceUuid)` with `resourceType: "DOCUMENT"` (needs editor access).
4. **Read the existing discussion** before adding to it: `list_comments(documentUuid)`. Do not repeat a
   point someone already made; reply to it instead.
5. **Attachments** (metadata only, no file contents): `list_attachments(projectUuid)` and
   `get_attachment(uuid)`.
6. **Leave the review.** Summarize your findings to the user first. When they asked for comments, post
   them with `create_comments(documentUuid, items)`:
   - One point per comment, quoting the passage it is about.
   - Use `kind: "QUESTION"` for questions that need an answer; a question can later be resolved.
   - Reply in a thread with `parentCommentId` (replies are one level deep).
   - To mention someone, get their `userId` and `displayName` from
     `list_mention_candidates(documentUuid, query)`, write `@<displayName>` in the body, list them in
     `mentionUserIds`, and set a `clientMutationId` so a retry does not send the email twice.
   - `create_comments(mailLanguage)` picks the language of the notification email (`en` or `ko`).
7. **Follow-up.** Edit your own comment with `update_comments(documentUuid, items)`. Mark answered
   questions resolved with `resolve_comments(documentUuid, ids)` — this needs edit access and cannot
   be undone, so confirm with the user first.

## Tools

| Read | Write |
|---|---|
| `search_documents` · `list_documents` · `get_document` · `list_versions` · `get_version` · `list_history` · `list_comments` · `list_mention_candidates` · `list_attachments` · `get_attachment` · `identity_get_self` | `create_comments` · `update_comments` · `resolve_comments` — and only on explicit request: `update_documents` · `markdown_append_document` |

## Cautions

- A review does not edit the document. Change the body only when the user explicitly asks:
  `update_documents(items)` replaces the whole body (read the document first and send the full new
  text); `markdown_append_document(items)` adds to the end of a Markdown document. Both are kept in
  version history.
- Comments, replies and mentions send notification emails to other people. Keep them specific and
  polite, and do not post drafts.
- Always give the user the link of the document you reviewed.
