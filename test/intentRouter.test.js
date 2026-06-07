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
    board_strategy: "create_new_group",
    visual_summary_goal: "Map the user's thinking into a compact board artifact.",
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
  assert.equal(intent.board_strategy, "create_new_group");
  assert.match(intent.visual_summary_goal, /compact board artifact/);
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
      board_strategy: "no_board",
      visual_summary_goal: "",
      reason: "This is a casual greeting and does not need a persistent artifact.",
      confidence: 0.88,
      tool_plan: [],
    }),
  });

  assert.equal(intent.intent_type, "answer_simple");
  assert.equal(intent.artifact_type, "conversation");
  assert.equal(intent.target_artifact, "conversation");
  assert.equal(intent.should_use_whiteboard, false);
  assert.equal(intent.board_strategy, "no_board");
});

test("fallback routes process descriptions to a process flow board artifact", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;

    const intent = await routeUserIntent({
      user_goal: "Describe the onboarding process for a new customer",
    });

    assert.equal(intent.should_use_whiteboard, true);
    assert.equal(intent.artifact_type, "process_flow");
    assert.equal(intent.target_artifact, "process_flow");
    assert.equal(intent.board_strategy, "create_new_group");
    assert.equal(intent.route_action, "use_whiteboard");
    assert.equal(intent.tool_plan[0].tool, "submit_whiteboard_command");
    assert.equal(intent.board_command.command_type, "create_artifact");
    assert.match(intent.visual_summary_goal, /onboarding process/i);
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
  }
});

test("fallback routes architecture, comparison, and action plan requests to board artifacts", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;

    const architecture = await routeUserIntent({ user_goal: "Design the architecture for the voice AI whiteboard" });
    const comparison = await routeUserIntent({ user_goal: "Compare enterprise pilots and self serve launch paths" });
    const actionPlan = await routeUserIntent({ user_goal: "Make an action plan for the next two weeks" });

    assert.equal(architecture.artifact_type, "architecture_map");
    assert.equal(architecture.should_use_whiteboard, true);
    assert.equal(comparison.artifact_type, "comparison_map");
    assert.equal(comparison.should_use_whiteboard, true);
    assert.equal(actionPlan.artifact_type, "action_plan");
    assert.equal(actionPlan.should_use_whiteboard, true);
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
  }
});

test("fallback keeps casual chat off the board and supports multilingual board-first requests", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;

    const casual = await routeUserIntent({ user_goal: "Good morning, how are you?" });
    const italianProcess = await routeUserIntent({ user_goal: "Descrivi il processo di approvazione dei rimborsi" });

    assert.equal(casual.should_use_whiteboard, false);
    assert.equal(casual.artifact_type, "conversation");
    assert.equal(casual.board_strategy, "no_board");
    assert.equal(italianProcess.should_use_whiteboard, true);
    assert.equal(italianProcess.artifact_type, "process_flow");
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
  }
});

test("fallback chooses refine strategy for related board follow-ups", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const board = createBoardState();
  applyBoardOperations(board, [
    { type: "create_node", id: "node-onboarding", text: "Customer onboarding", x: 10, y: 20 },
  ]);

  try {
    delete process.env.OPENAI_API_KEY;

    const intent = await routeUserIntent({
      user_goal: "Refine this and add the missing approval step",
      visible_board_context: "Board shows customer onboarding.",
    }, { board });

    assert.equal(intent.should_use_whiteboard, true);
    assert.equal(intent.board_strategy, "refine_existing");
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
  }
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
  assert.equal(seenInput.current_board_context.nodes[0].title, "Existing board topic");
  assert.equal(seenInput.current_board_context.version, board.version);
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

test("orchestrator input event uses info status", async () => {
  const events = [];
  const recorder = {
    recordEvent(event) {
      events.push(event);
    },
  };

  await routeUserIntent({
    user_goal: "Say hello",
  }, {
    recorder,
    decisionProvider: async () => ({
      intent_type: "answer_simple",
      artifact_type: "conversation",
      should_use_whiteboard: false,
      route_action: "answer_conversationally",
      board_strategy: "no_board",
      visual_summary_goal: "",
      reason: "This is a casual greeting and does not need a persistent artifact.",
      confidence: 0.88,
      required_context: [],
      preferred_model: "gpt-4.1-mini",
      tool_plan: [],
    }),
  });

  assert.ok(events.some((event) => event.category === "orchestrator" && event.action === "orchestrator_input" && event.status === "info"));
});
