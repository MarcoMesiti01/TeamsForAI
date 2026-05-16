const test = require("node:test");
const assert = require("node:assert/strict");

const { delegateToBrain } = require("../lib/brainService");
const { createBoardState } = require("../lib/boardState");

test("brain returns spoken summary, reasoning summary, board operations, and undo checkpoint", async () => {
  const state = {
    last_task_type: "general",
    last_user_goal: "",
    board: createBoardState(),
  };

  const result = await delegateToBrain({
    intent_type: "develop_idea_map",
    user_goal: "Map a voice-first AI whiteboard for founders",
    artifact_type: "idea_map",
    target_artifact: "idea_map",
    should_use_whiteboard: true,
    route_action: "use_whiteboard",
    reason: "A spatial map will help structure the founder workflow.",
    required_context: [],
    preferred_model: "gpt-4.1-mini",
    tool_plan: [{ tool: "delegate_to_brain", args: {}, reason: "Create the map." }],
    known_context: "Focus on product thinking.",
    missing_info: [],
    confidence: 0.86,
  }, state);

  assert.equal(result.handled_by, "brain");
  assert.equal(typeof result.spoken_summary, "string");
  assert.ok(result.spoken_summary.length > 0);
  assert.equal(typeof result.reasoning_summary, "string");
  assert.ok(Array.isArray(result.board_operations));
  assert.ok(result.board_operations.length >= 3);
  assert.equal(typeof result.undo_checkpoint_id, "string");
  assert.equal(state.board.undo_stack.at(-1).checkpoint_id, result.undo_checkpoint_id);
  assert.equal(result.board_context.version, 0);
  assert.equal(Array.isArray(result.board_context.nodes), true);
  assert.equal(typeof result.layout_notes, "string");
});

test("brain keeps deterministic board labels in the detected request language", async () => {
  const state = {
    last_task_type: "general",
    last_user_goal: "",
    board: createBoardState(),
  };

  const result = await delegateToBrain({
    intent_type: "develop_idea_map",
    user_goal: "Descrivi il processo di approvazione dei rimborsi",
    target_artifact: "idea_map",
    known_context: "",
    missing_info: [],
    confidence: 0.86,
  }, state);

  const nodeTexts = result.board_operations
    .filter((operation) => operation.type === "create_node")
    .map((operation) => operation.text);

  assert.ok(nodeTexts.includes("Obiettivo utente"));
});
