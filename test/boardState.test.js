const test = require("node:test");
const assert = require("node:assert/strict");

const { createBoardState, applyBoardOperations, undoLastCheckpoint } = require("../lib/boardState");

test("applies idea-map operations and records them in an append-only log", () => {
  const board = createBoardState();
  const result = applyBoardOperations(board, [
    { type: "create_node", id: "node-1", text: "Voice-first AI whiteboard", x: 120, y: 80 },
    { type: "create_node", id: "node-2", text: "Founder workflows", x: 360, y: 80 },
    { type: "create_edge", id: "edge-1", from: "node-1", to: "node-2", label: "supports" },
    { type: "create_group", id: "group-1", title: "Product thesis", node_ids: ["node-1", "node-2"] },
    { type: "emphasize_item", id: "node-1", emphasis: "primary" },
  ], { source: "ai" });

  assert.equal(result.ok, true);
  assert.equal(board.nodes.length, 2);
  assert.equal(board.edges.length, 1);
  assert.equal(board.groups.length, 1);
  assert.equal(board.operation_log.length, 5);
  assert.equal(board.undo_stack.length, 1);
  assert.equal(board.undo_stack[0].checkpoint_id, result.undo_checkpoint_id);
});

test("create and update node retain workspace provenance metadata", () => {
  const board = createBoardState();

  applyBoardOperations(board, [
    {
      type: "create_node",
      id: "node-option",
      text: "Use canary rollout",
      x: 120,
      y: 80,
      workspace_entry_id: "option-canary",
      memory_status: "committed",
      origin: "workspace",
    },
  ], { source: "ai" });

  assert.equal(board.nodes[0].workspace_entry_id, "option-canary");
  assert.equal(board.nodes[0].memory_status, "committed");
  assert.equal(board.nodes[0].origin, "workspace");

  applyBoardOperations(board, [
    { type: "update_node", id: "node-option", text: "Use staged rollout" },
  ], { source: "ai" });

  assert.equal(board.nodes[0].text, "Use staged rollout");
  assert.equal(board.nodes[0].workspace_entry_id, "option-canary");
  assert.equal(board.nodes[0].memory_status, "committed");
  assert.equal(board.nodes[0].origin, "workspace");

  applyBoardOperations(board, [
    {
      type: "update_node",
      id: "node-option",
      workspace_entry_id: "option-rollout",
      memory_status: "exploratory",
      origin: "voice",
    },
  ], { source: "ai" });

  assert.equal(board.nodes[0].workspace_entry_id, "option-rollout");
  assert.equal(board.nodes[0].memory_status, "exploratory");
  assert.equal(board.nodes[0].origin, "voice");
});

test("created nodes default provenance metadata to exploratory", () => {
  const board = createBoardState();
  applyBoardOperations(board, [
    { type: "create_node", id: "node-idea", text: "New idea", x: 0, y: 0 },
  ], { source: "ai" });

  assert.equal(board.nodes[0].workspace_entry_id, null);
  assert.equal(board.nodes[0].memory_status, "exploratory");
  assert.equal(board.nodes[0].origin, null);
});

test("create node sanitizes invalid workspace provenance metadata before persistence", () => {
  const board = createBoardState();
  applyBoardOperations(board, [
    {
      type: "create_node",
      id: "node-invalid",
      text: "Invalid metadata",
      x: 0,
      y: 0,
      workspace_entry_id: { id: "entry-object" },
      memory_status: "archived",
      origin: "",
    },
  ], { source: "ai" });

  assert.equal(board.nodes[0].workspace_entry_id, null);
  assert.equal(board.nodes[0].memory_status, "exploratory");
  assert.equal(board.nodes[0].origin, null);
  assert.equal(board.operation_log[0].workspace_entry_id, null);
  assert.equal(board.operation_log[0].memory_status, "exploratory");
  assert.equal(board.operation_log[0].origin, null);
});

test("update node sanitizes provided provenance while preserving absent metadata", () => {
  const board = createBoardState();
  applyBoardOperations(board, [
    {
      type: "create_node",
      id: "node-option",
      text: "Use canary rollout",
      x: 0,
      y: 0,
      workspace_entry_id: "option-canary",
      memory_status: "committed",
      origin: "user_stated",
    },
  ], { source: "ai" });

  applyBoardOperations(board, [
    {
      type: "update_node",
      id: "node-option",
      workspace_entry_id: [],
      memory_status: "pending",
      origin: 42,
    },
  ], { source: "ai" });

  assert.equal(board.nodes[0].workspace_entry_id, null);
  assert.equal(board.nodes[0].memory_status, "exploratory");
  assert.equal(board.nodes[0].origin, null);

  applyBoardOperations(board, [
    { type: "update_node", id: "node-option", text: "Use staged rollout" },
  ], { source: "ai" });

  assert.equal(board.nodes[0].text, "Use staged rollout");
  assert.equal(board.nodes[0].workspace_entry_id, null);
  assert.equal(board.nodes[0].memory_status, "exploratory");
  assert.equal(board.nodes[0].origin, null);
  assert.equal("workspace_entry_id" in board.operation_log.at(-1), false);
  assert.equal("memory_status" in board.operation_log.at(-1), false);
  assert.equal("origin" in board.operation_log.at(-1), false);
});

test("undo restores the board snapshot while preserving operation history", () => {
  const board = createBoardState();
  applyBoardOperations(board, [
    { type: "create_node", id: "node-1", text: "Temporary thought", x: 0, y: 0 },
  ], { source: "ai" });

  const beforeUndoLogLength = board.operation_log.length;
  const undo = undoLastCheckpoint(board);

  assert.equal(undo.ok, true);
  assert.equal(board.nodes.length, 0);
  assert.equal(board.operation_log.length, beforeUndoLogLength + 1);
  assert.equal(board.operation_log.at(-1).type, "undo");
});

test("moving a node creates an undoable user checkpoint", () => {
  const board = createBoardState();
  applyBoardOperations(board, [
    { type: "create_node", id: "node-1", text: "Movable thought", x: 40, y: 60 },
  ], { source: "ai" });

  const move = applyBoardOperations(board, [
    { type: "move_item", id: "node-1", x: 280, y: 190 },
  ], { source: "user" });

  assert.equal(move.ok, true);
  assert.equal(board.nodes[0].x, 280);
  assert.equal(board.nodes[0].y, 190);
  assert.equal(board.operation_log.at(-1).source, "user");

  const undo = undoLastCheckpoint(board);

  assert.equal(undo.ok, true);
  assert.equal(board.nodes[0].x, 40);
  assert.equal(board.nodes[0].y, 60);
});

test("rejects unsupported board operation types", () => {
  const board = createBoardState();

  assert.throws(
    () => applyBoardOperations(board, [{ type: "freeform_draw", text: "bad" }]),
    /Unsupported board operation/
  );
});
