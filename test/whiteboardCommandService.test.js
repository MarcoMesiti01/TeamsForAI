const test = require("node:test");
const assert = require("node:assert/strict");

const { createBoardState, applyBoardOperations } = require("../lib/boardState");
const {
  normalizeWhiteboardCommand,
  buildWhiteboardCommandFromIntent,
  resolveCommandTargets,
  planOperationsForCommand,
} = require("../lib/whiteboardCommandService");

test("normalizes valid whiteboard command JSON", () => {
  const command = normalizeWhiteboardCommand({
    command_type: "modify_item",
    artifact_type: "idea_map",
    user_goal: "Update the pricing node",
    target_selector: { text: "Pricing" },
    target_confidence: 0.82,
    change_description: "Rename it to Pricing strategy",
    constraints: { preserve_layout: true },
  });

  assert.equal(command.command_type, "modify_item");
  assert.equal(command.artifact_type, "idea_map");
  assert.equal(command.target_selector.text, "Pricing");
  assert.equal(command.target_confidence, 0.82);
  assert.equal(command.allow_destructive, false);
});

test("rejects unsupported whiteboard command types", () => {
  assert.throws(
    () => normalizeWhiteboardCommand({ command_type: "paint_canvas", user_goal: "Draw something" }),
    /Unsupported whiteboard command/
  );
});

test("builds command JSON from board-first orchestrator intent", () => {
  const command = buildWhiteboardCommandFromIntent({
    user_goal: "Describe the onboarding process",
    artifact_type: "process_flow",
    target_artifact: "process_flow",
    should_use_whiteboard: true,
    board_strategy: "create_new_group",
    visual_summary_goal: "Show onboarding as ordered steps.",
    confidence: 0.76,
  });

  assert.equal(command.command_type, "create_artifact");
  assert.equal(command.artifact_type, "process_flow");
  assert.equal(command.board_strategy, "create_new_group");
  assert.equal(command.target_confidence, 0.76);
});

test("resolves command targets by id, selected item, text, group, and semantic fallback", () => {
  const board = createBoardState();
  applyBoardOperations(board, [
    { type: "create_node", id: "node-pricing", text: "Pricing", x: 10, y: 20 },
    { type: "create_node", id: "node-onboarding", text: "Customer onboarding", x: 240, y: 20 },
    { type: "create_group", id: "group-growth", title: "Growth plan", node_ids: ["node-pricing", "node-onboarding"] },
  ]);

  assert.equal(resolveCommandTargets(normalizeWhiteboardCommand({
    command_type: "modify_item",
    user_goal: "Update pricing",
    target_selector: { id: "node-pricing" },
  }), board).targets[0].id, "node-pricing");

  assert.equal(resolveCommandTargets(normalizeWhiteboardCommand({
    command_type: "modify_item",
    user_goal: "Update this",
    target_selector: { selected: true },
  }), board, { selected_item: { id: "node-onboarding", type: "node" } }).targets[0].id, "node-onboarding");

  assert.equal(resolveCommandTargets(normalizeWhiteboardCommand({
    command_type: "modify_item",
    user_goal: "Update pricing",
    target_selector: { text: "pricing" },
  }), board).targets[0].id, "node-pricing");

  assert.equal(resolveCommandTargets(normalizeWhiteboardCommand({
    command_type: "group_items",
    user_goal: "Work on the growth plan",
    target_selector: { group_title: "Growth" },
  }), board).targets[0].id, "group-growth");

  assert.equal(resolveCommandTargets(normalizeWhiteboardCommand({
    command_type: "modify_item",
    user_goal: "Improve customer onboarding",
    target_selector: {},
  }), board).targets[0].id, "node-onboarding");
});

test("low-confidence destructive commands do not produce operations", async () => {
  const board = createBoardState();
  applyBoardOperations(board, [
    { type: "create_node", id: "node-risk", text: "Risk", x: 10, y: 20 },
  ]);

  const result = await planOperationsForCommand(normalizeWhiteboardCommand({
    command_type: "delete_item",
    user_goal: "Maybe remove the risk node",
    target_selector: { text: "Risk" },
    target_confidence: 0.4,
    allow_destructive: true,
  }), board);

  assert.equal(result.status, "needs_clarification");
  assert.equal(result.board_operations.length, 0);
  assert.match(result.spoken_summary, /which item/i);
});

test("modify and connect commands produce raw operations from resolved targets", async () => {
  const board = createBoardState();
  applyBoardOperations(board, [
    { type: "create_node", id: "node-pricing", text: "Pricing", x: 10, y: 20 },
    { type: "create_node", id: "node-onboarding", text: "Onboarding", x: 240, y: 20 },
  ]);

  const modify = await planOperationsForCommand(normalizeWhiteboardCommand({
    command_type: "modify_item",
    user_goal: "Rename pricing",
    target_selector: { text: "Pricing" },
    target_confidence: 0.9,
    change_description: "Pricing strategy",
  }), board);

  const connect = await planOperationsForCommand(normalizeWhiteboardCommand({
    command_type: "connect_items",
    user_goal: "Connect pricing to onboarding",
    target_selector: { from_text: "Pricing", to_text: "Onboarding" },
    target_confidence: 0.9,
    change_description: "informs",
  }), board);

  assert.deepEqual(modify.board_operations, [
    { type: "update_node", id: "node-pricing", text: "Pricing strategy" },
  ]);
  assert.equal(connect.board_operations[0].type, "create_edge");
  assert.equal(connect.board_operations[0].from, "node-pricing");
  assert.equal(connect.board_operations[0].to, "node-onboarding");
});
