const test = require("node:test");
const assert = require("node:assert/strict");

const { createReasoningWorkspace, applyWorkspaceOperations } = require("../lib/reasoningWorkspace");
const { coordinateReasoningTurn } = require("../lib/turnCoordinatorService");

function createState() {
  return {
    workspace: createReasoningWorkspace(),
    board: {
      version: 0,
      nodes: [{ id: "node-1", text: "Launch plan", x: 0, y: 0 }],
      edges: [],
      groups: [],
      operation_log: [],
      undo_stack: [],
    },
    selected_item: { id: "node-1" },
    recently_moved_item: null,
  };
}

function committedOption(id, turnId, content = "Use canary rollout") {
  return {
    type: "add_entry",
    id,
    category: "options",
    content,
    origin: "user_stated",
    source_turn_id: turnId,
  };
}

function conversationalDecision() {
  return {
    intent_type: "answer_simple",
    artifact_type: "conversation",
    should_use_whiteboard: false,
    route_action: "answer_conversationally",
    board_strategy: "no_board",
    visual_summary_goal: "",
    reason: "No board needed.",
    confidence: 0.8,
    required_context: [],
    preferred_model: "test-router",
    tool_plan: [],
  };
}

test("applies committed memory before generating grounded response and visual command", async () => {
  const state = createState();
  let responseInput;
  let routeInput;

  const result = await coordinateReasoningTurn({
    turn_id: "turn-visual",
    user_goal: "Map canary rollout as the rollout option.",
  }, state, {
    updateProvider: async () => ({
      action: "update",
      operations: [committedOption("option-canary", "turn-visual")],
      spoken_commit_notice: "I saved canary as an option.",
    }),
    responseProvider: async (input) => {
      responseInput = input;
      return {
        spoken_summary: "Canary is now captured as the rollout option.",
        full_response: "The committed workspace includes canary rollout.",
        reasoning_summary: "Grounded in option-canary.",
        uncertainties: [],
        next_examination: "",
      };
    },
    routeProvider: async (input) => {
      routeInput = input;
      return {
        intent_type: "develop_idea_map",
        artifact_type: "idea_map",
        should_use_whiteboard: true,
        route_action: "use_whiteboard",
        board_strategy: "refine_existing",
        visual_summary_goal: "Show canary rollout in the launch map.",
        reason: "The user asked to map the option.",
        confidence: 0.92,
        required_context: [],
        preferred_model: "test-router",
        tool_plan: [],
        board_command: {
          command_type: "modify_item",
          change_description: "Add canary rollout to the map.",
        },
      };
    },
  });

  assert.equal(responseInput.workspace_context.active_entries.options[0].content, "Use canary rollout");
  assert.match(routeInput.compact_conversation_context, /Use canary rollout/);
  assert.equal(result.action, "update");
  assert.equal(result.spoken_summary, "Canary is now captured as the rollout option.");
  assert.equal(result.spoken_commit_notice, "I saved canary as an option.");
  assert.equal(result.board_sync_required, true);
  assert.equal(result.board_command.command_type, "modify_item");
  assert.equal(result.board_command.artifact_type, "idea_map");
  assert.equal(result.board_command.workspace_context.active_entries.options[0].id, "option-canary");
  assert.equal(result.board_command.sync_reason, "reasoning_turn");
});

test("undo voice turns reverse reasoning state without invoking response generation or routing", async () => {
  const state = createState();
  applyWorkspaceOperations(state.workspace, [committedOption("option-old", "turn-old")], {
    source: "test",
    turn_id: "turn-old",
  });
  let responseCalled = false;
  let routeCalled = false;

  const result = await coordinateReasoningTurn({
    turn_id: "turn-undo",
    utterance: "undo the last reasoning update",
  }, state, {
    updateProvider: async () => {
      throw new Error("provider should not be called for explicit undo");
    },
    responseProvider: async () => {
      responseCalled = true;
    },
    routeProvider: async () => {
      routeCalled = true;
    },
  });

  assert.equal(responseCalled, false);
  assert.equal(routeCalled, false);
  assert.equal(result.handled_by, "workspace");
  assert.equal(result.action, "undo");
  assert.equal(result.workspace_state.entries.length, 0);
  assert.equal(result.board_sync_required, true);
  assert.equal(result.board_command.command_type, "reorganize_artifact");
  assert.equal(result.board_command.artifact_type, "idea_map");
  assert.equal(result.board_command.sync_reason, "reasoning_undo");

  const failed = await coordinateReasoningTurn({
    turn_id: "turn-undo-empty",
    utterance: "undo the last reasoning update",
  }, state);

  assert.equal(failed.board_sync_required, false);
  assert.equal(failed.board_command, null);
});

test("clarify action does not apply operations or generate response", async () => {
  const state = createState();
  let responseCalled = false;

  const result = await coordinateReasoningTurn({
    turn_id: "turn-clarify",
    utterance: "that thing from before",
  }, state, {
    updateProvider: async () => ({
      action: "clarify",
      operations: [],
      needs_clarification: "Which reasoning item should I update?",
    }),
    responseProvider: async () => {
      responseCalled = true;
    },
  });

  assert.equal(responseCalled, false);
  assert.equal(result.handled_by, "turn_coordinator");
  assert.equal(result.action, "clarify");
  assert.equal(result.spoken_summary, "Which reasoning item should I update?");
  assert.equal(result.workspace_state.version, 0);
  assert.equal(result.board_sync_required, false);
  assert.equal(result.board_command, null);
});

test("committed corrections request board synchronization when route is conversational", async () => {
  const state = createState();
  applyWorkspaceOperations(state.workspace, [committedOption("option-old", "turn-old", "Use big bang rollout")], {
    source: "test",
    turn_id: "turn-old",
  });

  const result = await coordinateReasoningTurn({
    turn_id: "turn-correct",
    utterance: "Correct that to canary rollout.",
  }, state, {
    updateProvider: async () => ({
      action: "update",
      operations: [{
        type: "correct_entry",
        id: "option-old",
        replacement_id: "option-new",
        category: "options",
        content: "Use canary rollout",
        origin: "user_stated",
        source_turn_id: "turn-correct",
      }],
    }),
    responseProvider: async () => ({ spoken_summary: "Corrected to canary rollout." }),
    routeProvider: async () => conversationalDecision(),
  });

  assert.equal(result.board_sync_required, true);
  assert.equal(result.board_command.command_type, "reorganize_artifact");
  assert.equal(result.board_command.sync_reason, "committed_workspace_change");
  assert.equal(result.board_command.workspace_context.active_entries.options[0].id, "option-new");
});

test("working-memory-only update with conversational route does not require board sync", async () => {
  const state = createState();

  const result = await coordinateReasoningTurn({
    turn_id: "turn-working",
    utterance: "We are still comparing launch options.",
  }, state, {
    updateProvider: async () => ({
      action: "update",
      operations: [{
        type: "update_working_memory",
        summary: "Comparing launch options",
        current_topic: "Launch options",
      }],
    }),
    responseProvider: async () => ({ spoken_summary: "I noted that we are comparing launch options." }),
    routeProvider: async () => conversationalDecision(),
  });

  assert.equal(result.board_sync_required, false);
  assert.equal(result.board_command, null);
});

test("response failure preserves committed workspace and returns safe spoken summary", async () => {
  const state = createState();

  const result = await coordinateReasoningTurn({
    turn_id: "turn-response-fails",
    utterance: "Save canary rollout.",
  }, state, {
    updateProvider: async () => ({
      action: "update",
      operations: [committedOption("option-response-fails", "turn-response-fails")],
    }),
    responseProvider: async () => {
      throw new Error("response model offline");
    },
    routeProvider: async () => conversationalDecision(),
  });

  assert.equal(result.workspace_state.entries[0].id, "option-response-fails");
  assert.equal(result.response_error, "response model offline");
  assert.equal(result.spoken_summary, "I captured the reasoning update, but I could not complete the deeper analysis yet.");
});

test("routing failure after committed mutation returns deterministic reasoning sync command", async () => {
  const state = createState();

  const result = await coordinateReasoningTurn({
    turn_id: "turn-route-fails",
    utterance: "Save canary rollout.",
  }, state, {
    updateProvider: async () => ({
      action: "update",
      operations: [committedOption("option-route-fails", "turn-route-fails")],
    }),
    responseProvider: async () => ({ spoken_summary: "Canary rollout is saved." }),
    routeProvider: async () => {
      throw new Error("router offline");
    },
  });

  assert.equal(result.workspace_state.entries[0].id, "option-route-fails");
  assert.equal(result.spoken_summary, "Canary rollout is saved.");
  assert.equal(result.board_sync_error, "router offline");
  assert.equal(result.board_sync_required, true);
  assert.equal(result.board_command.command_type, "reorganize_artifact");
  assert.equal(result.board_command.artifact_type, "idea_map");
  assert.equal(result.board_command.sync_reason, "committed_workspace_change");
  assert.equal(result.board_command.workspace_context.active_entries.options[0].id, "option-route-fails");
});

test("routing failure after working-memory-only update does not require board sync", async () => {
  const state = createState();

  const result = await coordinateReasoningTurn({
    turn_id: "turn-working-route-fails",
    utterance: "We are still comparing launch options.",
  }, state, {
    updateProvider: async () => ({
      action: "update",
      operations: [{
        type: "update_working_memory",
        summary: "Comparing launch options",
        current_topic: "Launch options",
      }],
    }),
    responseProvider: async () => ({ spoken_summary: "I noted that we are comparing launch options." }),
    routeProvider: async () => {
      throw new Error("router offline");
    },
  });

  assert.equal(result.spoken_summary, "I noted that we are comparing launch options.");
  assert.equal(result.board_sync_error, "router offline");
  assert.equal(result.board_sync_required, false);
  assert.equal(result.board_command, null);
});

test("result includes realtime workspace briefing containing committed entries", async () => {
  const state = createState();

  const result = await coordinateReasoningTurn({
    turn_id: "turn-briefing",
    utterance: "Save canary rollout.",
  }, state, {
    updateProvider: async () => ({
      action: "update",
      operations: [committedOption("option-briefing", "turn-briefing")],
    }),
    responseProvider: async () => ({ spoken_summary: "Saved canary rollout." }),
    routeProvider: async () => conversationalDecision(),
  });

  assert.match(result.workspace_briefing, /Shared reasoning workspace briefing/);
  assert.match(result.workspace_briefing, /Use canary rollout/);
  assert.match(result.workspace_briefing, /Reasoning undo available: yes/);
});

test("uses conversation summary when realtime tool omits user goal, utterance, and spoken context", async () => {
  const state = createState();
  const events = [];
  let updateUtterance = "";

  const result = await coordinateReasoningTurn({
    turn_id: "turn-summary-only",
    conversation_summary: "The user is comparing enterprise pilots with self-serve launch.",
  }, state, {
    recorder: {
      recordEvent(event) {
        events.push(event);
      },
    },
    updateProvider: async (modelInput) => {
      updateUtterance = modelInput.utterance;
      return {
        action: "update",
        operations: [{
          type: "update_working_memory",
          summary: modelInput.utterance,
          current_topic: "Launch path comparison",
        }],
      };
    },
    responseProvider: async () => ({ spoken_summary: "I captured the launch path comparison." }),
    routeProvider: async () => conversationalDecision(),
  });

  assert.equal(result.action, "update");
  assert.equal(updateUtterance, "The user is comparing enterprise pilots with self-serve launch.");
  assert.equal(result.workspace_state.working_memory.current_topic, "Launch path comparison");
  assert.ok(events.some((event) => event.category === "frontend" && event.action === "invalid_tool_arguments"));
});

test("empty realtime tool arguments return clarification instead of throwing", async () => {
  const state = createState();
  const events = [];
  let updateCalled = false;

  const result = await coordinateReasoningTurn({}, state, {
    recorder: {
      recordEvent(event) {
        events.push(event);
      },
    },
    updateProvider: async () => {
      updateCalled = true;
      return {
        action: "update",
        operations: [],
      };
    },
  });

  assert.equal(updateCalled, false);
  assert.equal(result.action, "clarify");
  assert.equal(result.board_sync_required, false);
  assert.equal(result.workspace_state.version, 0);
  assert.ok(events.some((event) => event.category === "frontend" && event.action === "invalid_tool_arguments"));
});
