---
name: create-project
description: Set up new work in AiNecto — a workspace or project, its folders, and the first documents such as a design doc and a kanban board. Use when the user asks to create, start or set up a new AiNecto project or workspace, or to lay out folders and starter documents in one.
---

# Create a project

Create a place for new work in AiNecto and lay out its first folders and documents, without making
duplicates.

## When to use

- "Create an AiNecto project for the mobile app with a design folder and a board."
- "Set up a new workspace for the client project."

## Steps

1. **Look before creating.** Names do not have to be unique, so check what already exists:
   - Projects the user can open, in every workspace: `list_projects(q)` or
     `list_projects(workspaceUuid)`. Read one with `get_project(uuid)`.
   - Workspaces the user can open — their own and the ones shared with them: `list_workspaces`. Each
     row says how they see it (`access`: OWNER, GRANT or PARTIAL) and their role (`myRole`); VIEWER
     and PARTIAL cannot create projects there. Read one with `get_workspace(uuid)`.
   - If the workspace, project or folder the user named is not found, or more than one fits, stop:
     show the candidates and ask. Never create it somewhere else instead (such as the user's personal
     workspace or a new project).
   - Who the user is: `identity_get_self`.
2. **Agree on the plan.** Show the user what you will create — workspace, project name (and optional
   `projectKey`), folders, starter documents — and wait for confirmation.
3. **Create the workspace** only if the user wants a new one: `create_workspaces(items)`. It creates a
   personal workspace owned by the user.
4. **Create the project:** `create_projects(items)` with the target `workspaceUuid` from
   `list_workspaces`. Leave `workspaceUuid` out only when the user wants the project in their own
   personal workspace. `projectKey` must be unique in the workspace.
5. **Create folders:** check `list_folders(projectUuid)` first, then `create_folders(items)` — nest
   them with `parentFolderUuid`.
6. **Create starter documents:** `create_documents(items)` with the `projectUuid` (not a workspace
   uuid), an optional `folderUuid`, a `type` and a `title`. A Markdown document takes its body in
   `typePayload`; `type: "kanban"` creates an empty board — add cards with the manage-kanban skill.
   If the result has a `DUPLICATE_TITLE` warning, a document with the same title already sits in that
   place (`duplicateOf`): tell the user and ask whether to delete one.
7. **Adjust:** rename a project or change its description with `update_projects(items)` (needs admin
   or owner rights).
8. **Report** every created item with its link.

## Tools

| Read | Write (after the user confirms the plan) |
|---|---|
| `list_workspaces` · `get_workspace` · `list_projects` · `get_project` · `list_folders` · `identity_get_self` | `create_workspaces` · `create_projects` · `create_folders` · `create_documents` · `update_projects` |

## Cautions

- Every create call makes new items, even with the same name. If a call fails or times out, read the
  current state again (`list_projects`, `list_folders`) before retrying.
- Items in one call commit one by one: the first failing item stops the call, earlier items stay
  created and later ones are not tried.
- Creating in a workspace needs edit access there; an archived workspace or project refuses new items.
