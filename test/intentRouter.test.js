const test = require("node:test");
const assert = require("node:assert/strict");

const { routeUserIntent } = require("../lib/intentRouter");
const { buildOrchestratorInput } = require("../lib/orchestratorService");
const { createBoardState, applyBoardOperations } = require("../lib/boardState");

function modelDecision(overrides = {}) {
  return {
    intent_type: "develop_idea_map",
    artifact_type: "idea_map",
    should_use_whiteboard: true,
    route_action: "use_whiteboard",
    reason: "The user is asking for multi-part product thinking that benefits from a spatial artifact.",
    confidence: 0.91,
    required_context: [],
    preferred_model: "gpt-4.1-mini",
    tool_plan: [
      { tool: "delegate_to_brain", args: { artifact_type: "idea_map" }, reason: "Generate board operations." },
    ],
    ...overrides,
  };
}

test("routes founder idea-map requests from orchestrator JSON", async () => {
  const intent = await routeUserIntent({
    user_goal: "Help me map an AI whiteboard product for startup founders",
    collected_context: "We want voice-first thinking and diagrams.",
  }, {
    decisionProvider: async () => modelDecision(),
  });

  assert.equal(intent.intent_type, "develop_idea_map");
  assert.equal(intent.artifact_type, "idea_map");
  assert.equal(intent.target_artifact, "idea_map");
  assert.equal(intent.should_use_whiteboard, true);
  assert.equal(intent.route_action, "use_whiteboard");
  assert.equal(intent.user_goal, "Help me map an AI whiteboard product for startup founders");
  assert.deepEqual(intent.required_context, []);
  assert.equal(typeof intent.reason, "string");
  assert.ok(Array.isArray(intent.tool_plan));
  assert.ok(intent.confidence >= 0.5);
});

test("keeps casual conversation off the board when orchestrator says conversation", async () => {
  const intent = await routeUserIntent({
    user_goal: "Good morning, how are you?",
  }, {
    decisionProvider: async () => modelDecision({
      intent_type: "answer_simple",
      artifact_type: "conversation",
      should_use_whiteboard: false,
      route_action: "answer_conversationally",
      reason: "This is a casual greeting and does not need a persistent artifact.",
      confidence: 0.88,
      tool_plan: [],
    }),
  });

  assert.equal(intent.intent_type, "answer_simple");
  assert.equal(intent.artifact_type, "conversation");
  assert.equal(intent.target_artifact, "conversation");
  assert.equal(intent.should_use_whiteboard, false);
});

test("passes compact conversation context and current board snapshot to orchestrator", async () => {
  const board = createBoardState();
  applyBoardOperations(board, [
    { type: "create_node", id: "node-existing", text: "Existing board topic", x: 10, y: 20 },
  ]);

  let seenInput;
  await routeUserIntent({
    user_goal: "Where should we expand this next?",
    messages: [
      { role: "user", content: "Let's define the buyer." },
      { role: "assistant", content: "I added buyer discovery to the board." },
    ],
  }, {
    board,
    decisionProvider: async (input) => {
      seenInput = input;
      return modelDecision();
    },
  });

  assert.equal(seenInput.current_user_turn, "Where should we expand this next?");
  assert.match(seenInput.compact_conversation_context, /buyer discovery/);
  assert.equal(seenInput.current_board_snapshot.nodes[0].text, "Existing board topic");
  assert.ok(seenInput.available_capabilities.artifacts.includes("idea_map"));
});

test("uses deterministic fallback only for explicit undo commands", async () => {
  const intent = await routeUserIntent({ user_goal: "Undo that last board change" });

  assert.equal(intent.intent_type, "undo");
  assert.equal(intent.route_action, "undo");
  assert.equal(intent.tool_plan[0].tool, "undo_board_operation");
});


test("uses orchestrator policy default when model routing falls back without an API key", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.ORCHESTRATOR_MODEL;

  try {
    delete process.env.OPENAI_API_KEY;
    process.env.ORCHESTRATOR_MODEL = "test-orchestrator-model";

    const intent = await routeUserIntent({ user_goal: "Say hello" });

    assert.equal(intent.route_action, "answer_conversationally");
    assert.equal(intent.preferred_model, "test-orchestrator-model");
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }

    if (previousModel === undefined) {
      delete process.env.ORCHESTRATOR_MODEL;
    } else {
      process.env.ORCHESTRATOR_MODEL = previousModel;
    }
  }
});

test("rejects unsupported router payloads instead of returning free-form actions", async () => {
  await assert.rejects(
    () => routeUserIntent({ user_goal: "" }),
    /user_goal is required/
  );
});

test("builds orchestrator input from aliases", () => {
  const input = buildOrchestratorInput({ current_user_turn: "Clarify the roadmap" });
  assert.equal(input.current_user_turn, "Clarify the roadmap");
  assert.equal(input.current_board_snapshot.version, 0);
});


test("builds orchestrator input from realtime delegate context fields", () => {
  const input = buildOrchestratorInput({
    user_goal: "Compare these launch paths",
    spoken_context: "The user mentioned enterprise pilots and self-serve onboarding.",
    conversation_summary: "We are discussing a founder roadmap.",
    visible_board_context: "Board shows pricing, onboarding, and ICP nodes.",
    user_preference: "Keep it concise.",
    response_mode: "board_artifact",
    candidate_artifact_type: "comparison",
  });

  assert.equal(input.current_user_turn, "Compare these launch paths");
  assert.match(input.compact_conversation_context, /founder roadmap/);
  assert.match(input.compact_conversation_context, /enterprise pilots/);
  assert.match(input.compact_conversation_context, /Keep it concise/);
  assert.equal(input.visible_board_context, "Board shows pricing, onboarding, and ICP nodes.");
  assert.equal(input.response_mode, "board_artifact");
  assert.equal(input.candidate_artifact_type, "comparison");
});
