---
title: "Board Operation Protocol"
category: concept
sources:
  - "raw/repos/2026-05-18-repository-readme.md"
  - "raw/repos/2026-05-18-codebase-inventory.md"
created: 2026-05-18
updated: 2026-05-18
tags: [board-state, operations, undo, validation, whiteboard]
aliases: [Board Protocol, Typed Board Operations]
confidence: high
volatility: warm
verified: 2026-05-18
summary: "Explains the typed operation model used to mutate the whiteboard, including validation, operation log, snapshots, and undo checkpoints."
---

# Board Operation Protocol

> The board is mutated only through a small set of typed operations. This makes AI-generated changes, direct user edits, undo, validation, and frontend rendering share one state model.

## Data Shape

The board state contains:

- `version`: incremented as operations and undo actions are applied.
- `nodes`: draggable cards with text, coordinates, optional group id, and emphasis.
- `edges`: relationships between node ids with optional labels.
- `groups`: titled regions containing node ids.
- `operation_log`: append-only record of applied operations with source, checkpoint, timestamp, and version.
- `undo_stack`: snapshots taken before operation batches.

## Supported Operations

The protocol supports `create_node`, `update_node`, `create_edge`, `create_group`, `move_item`, `emphasize_item`, `delete_item`, and `undo`.

AI paths and user paths both use this operation language. For example, the whiteboard planner creates nodes, groups, and edges, while drag-and-drop sends `move_item` through `POST /board/operations`.

For deeper operation-by-operation mechanics, read [[operation-lifecycle|Operation Lifecycle]] ([Operation Lifecycle](operation-lifecycle.md)).

## Validation Layer

`lib/boardOperationValidator.js` filters operation batches before mutation. It rejects unsupported operation types, missing ids, duplicate create ids, invalid coordinates, missing edge endpoints, invalid group references, and destructive operations unless explicitly allowed.

The validator is especially important because operations can originate from model output. The planner can fall back to deterministic layouts when model output fails validation.

## Mutation And Undo

`lib/boardState.js` applies operations and records a checkpoint before each batch. Undo restores the previous snapshot, increments the board version, and appends an `undo` entry to the operation log. The log remains append-only even when the visible board rolls back.

This design makes undo user-visible and auditable: the board can return to a prior state without erasing the fact that operations happened.

## See Also

- [[runtime-request-flow|Runtime Request Flow]] ([Runtime Request Flow](../topics/runtime-request-flow.md)) - where operations are created and applied.
- [[whiteboard-planning-and-jobs|Whiteboard Planning And Jobs]] ([Whiteboard Planning And Jobs](whiteboard-planning-and-jobs.md)) - how planned operations become async board updates.
- [[operation-lifecycle|Operation Lifecycle]] ([Operation Lifecycle](operation-lifecycle.md)) - how each operation is validated, applied, logged, and rendered.
- [[code-navigation-guide|Code Navigation Guide]] ([Code Navigation Guide](../references/code-navigation-guide.md)) - files that implement the protocol.

## Sources

- [TeamsForAI Repository README](../../raw/repos/2026-05-18-repository-readme.md) - supported operation list and board behavior.
- [TeamsForAI Codebase Inventory](../../raw/repos/2026-05-18-codebase-inventory.md) - board state and validator module responsibilities.
