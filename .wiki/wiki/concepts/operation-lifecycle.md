---
title: "Operation Lifecycle"
category: concept
sources:
  - "raw/repos/2026-05-18-codebase-inventory.md"
  - "raw/repos/2026-05-18-repository-readme.md"
created: 2026-05-18
updated: 2026-05-18
tags: [operations, board-state, validation, lifecycle, undo]
aliases: [Board Operation Lifecycle, Operation By Operation]
confidence: high
volatility: warm
verified: 2026-05-18
summary: "Operation-by-operation explanation of how whiteboard changes are created, validated, applied, logged, undone, and rendered."
---

# Operation Lifecycle

> Every visible board change becomes a typed operation batch. The lifecycle is: intent or gesture creates operations, validator filters unsafe operations, board state applies mutations, the operation log records them, undo stores a pre-batch snapshot, and the frontend renders the returned snapshot.

## Creation Paths

`submit_whiteboard_command` and `/board/commands` create high-level commands such as create, modify, connect, group, reorganize, emphasize, move, delete, or replace. `planOperationsForCommand` converts them into raw board operations.

The planner path creates artifact batches. It receives board context, supported operation types, layout constraints, and the visual goal. If the model fails or returns invalid operations, deterministic fallback builders create operations for idea maps, process flows, architecture maps, comparison maps, or action plans.

The direct manipulation path creates operations from UI gestures. Dragging a node sends exactly one `move_item` operation to `/board/operations` when the pointer is released.

Undo is special. It can be requested through Realtime (`undo_board_operation`) or HTTP (`/board/undo`) and calls `undoLastCheckpoint` directly instead of passing through the normal batch validator.

## Validation Process

`validateBoardOperations` returns valid operations plus warnings. It does not mutate the board.

The validator first rejects non-array batches. It then builds sets of existing ids, current node ids, and node ids that will be created in the same batch. For each operation, it checks object shape, supported type, destructive permission, id presence, duplicate create ids, finite coordinates, edge endpoint existence, and group node references.

Destructive operations are intentionally gated. `delete_item` and `undo` are dropped unless `allowDestructive` is true. Higher-level delete and replace commands are also blocked before validation unless the command has explicit destructive permission and high target confidence.

## Batch Application

`applyBoardOperations` applies a batch transactionally at the application level. It requires operation types, creates one checkpoint id, snapshots the board before any operation, applies each operation in order, increments board version after every operation, appends a log entry for every operation, then pushes one undo checkpoint for the whole batch.

The board does not store patches. Undo stores the pre-batch snapshot, so rollback restores the full visible board from before the batch.

## Operation Types

`create_node` adds or updates a node with `id`, `text`, finite `x` and `y`, optional `group_id`, and `emphasis`. Missing text becomes `Untitled thought`; missing coordinates fall back to `120,120` at the mutation layer, although the validator normally requires finite coordinates.

`update_node` finds an existing node by `id` and updates only supplied mutable fields. It currently supports text and group id changes. Missing nodes are ignored.

`create_edge` adds or updates an edge with `id`, `from`, `to`, and optional label. Mutation skips operations without endpoints; validation also rejects endpoints that do not reference known nodes.

`create_group` adds or updates a group with `id`, title, and `node_ids`. Validation ensures group member ids are existing nodes or nodes created in the same batch.

`move_item` finds a node by `id` and updates finite `x` and `y` values. Frontend drag uses this operation so movement remains logged and undoable.

`emphasize_item` finds a node by `id` and sets emphasis, defaulting to `primary`. Rendering uses this to style the node as the main thought.

`delete_item` removes a node, edge, or group by id. When deleting a node, related edges are removed and the node id is removed from all groups. Because this is destructive, command and validator gates must allow it.

`undo` is recorded in the operation log when a checkpoint is restored. It is not applied as a normal mutation operation; `undoLastCheckpoint` owns the restore process.

## Logging And Undo

Every applied operation log entry includes the cloned operation, source, checkpoint id, timestamp, and board version. The source is usually `ai`, `user`, or `system`.

Each batch gets one undo checkpoint containing the checkpoint id, the pre-batch snapshot, and operation count. This means undo reverses the last batch, not a single operation inside that batch.

`undoLastCheckpoint` pops the latest checkpoint, restores version/nodes/edges/groups from the snapshot, increments version once more, and appends an `undo` entry. The log remains append-only even though visible state rolls back.

## Rendering Effects

The backend returns `board_state` snapshots after direct operations, undo, completed jobs, and brain-applied board plans.

The frontend `renderBoard` reads nodes, edges, groups, and `can_undo`. Nodes become draggable cards. Edges become curved SVG paths between node centers. Groups become padded regions around member nodes. The undo button is enabled only when `can_undo` is true.

## Failure Modes

Invalid model operations become warnings and usually trigger deterministic planner fallback. Direct command operations can return `needs_clarification` when the target cannot be resolved. Empty valid operation batches fail whiteboard jobs unless the command genuinely required no operation. Frontend drag failures roll the node back to its starting coordinates.

## See Also

- [[board-operation-protocol|Board Operation Protocol]] ([Board Operation Protocol](board-operation-protocol.md)) - compact protocol overview.
- [[backend-function-map|Backend Function Map]] ([Backend Function Map](../references/backend-function-map.md)) - functions that create and apply operations.
- [[frontend-function-map|Frontend Function Map]] ([Frontend Function Map](../references/frontend-function-map.md)) - browser rendering and drag persistence.
