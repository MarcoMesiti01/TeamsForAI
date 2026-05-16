const test = require("node:test");
const assert = require("node:assert/strict");

const { createBoardState, applyBoardOperations } = require("../lib/boardState");
const { buildWhiteboardPlanInput, planWhiteboardOperations } = require("../lib/whiteboardPlannerService");

test("builds planner input with board snapshot, supported operations, layout constraints, and session context", () => {
  const board = createBoardState();
  applyBoardOperations(board, [
    { type: "create_node", id: "node-existing", text: "Existing idea", x: 120, y: 80 },
  ]);

  const input = buildWhiteboardPlanInput({
    intent_type: "develop_idea_map",
    user_goal: "Expand the existing idea",
    target_artifact: "idea_map",
    artifact_description: "Add a compact expansion around the existing idea.",
    known_context: "The user moved the first node to the top-left.",
  }, board, {
    layout_constraints: { canvas_width: 1400, canvas_height: 900, min_node_spacing: 180 },
  });

  assert.equal(input.user_goal, "Expand the existing idea");
  assert.equal(input.artifact_description, "Add a compact expansion around the existing idea.");
  assert.equal(input.current_board_snapshot.nodes[0].text, "Existing idea");
  assert.equal(input.board_context.nodes[0].title, "Existing idea");
  assert.ok(input.supported_operation_types.includes("create_node"));
  assert.ok(input.supported_operation_types.includes("delete_item"));
  assert.equal(input.layout_constraints.canvas_width, 1400);
  assert.match(input.compact_session_context, /top-left/);
});

test("planner uses strict JSON planner output when operations validate", async () => {
  const board = createBoardState();
  const plan = await planWhiteboardOperations({
    intent_type: "develop_idea_map",
    user_goal: "Create a process map",
    target_artifact: "idea_map",
  }, board, {
    plannerProvider: async () => ({
      spoken_summary: "I added a process map.",
      reasoning_summary: "The existing board is empty, so I created a compact starter map.",
      layout_notes: "Nodes are spaced horizontally with a readable edge.",
      missing_info: [],
      board_operations: [
        { type: "create_node", id: "node-1", text: "Start", x: 120, y: 90 },
        { type: "create_node", id: "node-2", text: "Finish", x: 360, y: 90 },
        { type: "create_edge", id: "edge-1", from: "node-1", to: "node-2", label: "then" },
      ],
    }),
  });

  assert.equal(plan.used_fallback, false);
  assert.equal(plan.spoken_summary, "I added a process map.");
  assert.equal(plan.layout_notes, "Nodes are spaced horizontally with a readable edge.");
  assert.deepEqual(plan.board_operations.map((operation) => operation.type), ["create_node", "create_node", "create_edge"]);
  assert.deepEqual(plan.validation_warnings, []);
});

test("planner falls back to fixture when planner output has invalid operations", async () => {
  const board = createBoardState();
  const plan = await planWhiteboardOperations({
    intent_type: "develop_idea_map",
    user_goal: "Create a process map",
    target_artifact: "idea_map",
  }, board, {
    plannerProvider: async () => ({
      spoken_summary: "Bad planner response",
      reasoning_summary: "This should be replaced.",
      layout_notes: "Invalid edge.",
      missing_info: [],
      board_operations: [
        { type: "create_edge", id: "edge-1", from: "node-1", to: "missing-node", label: "bad" },
      ],
    }),
  });

  assert.equal(plan.used_fallback, true);
  assert.equal(plan.board_operations.length, 9);
  assert.equal(plan.validation_warnings.length, 1);
  assert.match(plan.validation_warnings[0], /missing node references/);
});
