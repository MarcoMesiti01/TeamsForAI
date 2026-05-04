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
    target_artifact: "idea_map",
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
});
