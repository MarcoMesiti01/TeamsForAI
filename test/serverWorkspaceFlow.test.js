const test = require("node:test");
const assert = require("node:assert/strict");

const {
  app,
  resetServerStateForTest,
  setReasoningCoordinatorOptionsForTest,
} = require("../server");

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withServer(callback) {
  resetServerStateForTest();
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "";
  const { server, baseUrl } = await listen();
  try {
    await callback(baseUrl);
  } finally {
    await close(server);
    process.env.OPENAI_API_KEY = previousApiKey;
    resetServerStateForTest();
  }
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  assert.equal(response.ok, true);
  return response.json();
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

function coordinateBody(clientSessionId, turnId, userGoal) {
  return {
    name: "coordinate_reasoning_turn",
    client_session_id: clientSessionId,
    arguments: {
      user_goal: userGoal,
      spoken_context: userGoal,
      conversation_summary: "",
      visible_board_context: "",
      user_preference: "",
      response_mode: "short_answer",
      turn_id: turnId,
    },
  };
}

async function postJson(baseUrl, path, body) {
  return getJson(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("new session workspace state is empty and undo without checkpoint returns ok false", async () => {
  await withServer(async (baseUrl) => {
    const state = await getJson(`${baseUrl}/workspace/state?client_session_id=empty-session`);
    assert.equal(state.version, 0);
    assert.deepEqual(state.entries, []);
    assert.equal(state.can_undo, false);

    const undo = await postJson(baseUrl, "/workspace/undo", {
      client_session_id: "empty-session",
    });
    assert.equal(undo.ok, false);
    assert.equal(undo.board_sync_required, false);
    assert.equal(undo.whiteboard_job, null);
    assert.match(undo.workspace_briefing, /Shared reasoning workspace briefing/);
    assert.match(undo.realtime_session_instructions, /coordinate_reasoning_turn/);
  });
});

test("coordinate_reasoning_turn commits workspace entries and queues board sync", async () => {
  await withServer(async (baseUrl) => {
    setReasoningCoordinatorOptionsForTest({
      updateProvider: async () => ({
        action: "update",
        operations: [{
          type: "add_entry",
          id: "objective-reliability",
          category: "objectives",
          content: "Reliability matters for the new capability",
          origin: "user_stated",
          source_turn_id: "turn-commit",
        }],
        spoken_commit_notice: "I saved reliability as an objective.",
      }),
      responseProvider: async () => ({
        spoken_summary: "Reliability is now captured as an objective.",
        full_response: "The workspace now includes a reliability objective.",
        reasoning_summary: "Grounded in objective-reliability.",
        uncertainties: [],
        next_examination: "",
      }),
      routeProvider: async () => conversationalDecision(),
    });

    const result = await postJson(baseUrl, "/tools/execute", coordinateBody(
      "commit-session",
      "turn-commit",
      "Reliability matters for the new capability."
    ));

    assert.equal(result.handled_by, "turn_coordinator");
    assert.equal(result.action, "update");
    assert.equal(result.workspace_state.entries.length, 1);
    assert.equal(result.workspace_state.entries[0].id, "objective-reliability");
    assert.equal(result.workspace_state.entries[0].status, "active");
    assert.match(result.workspace_briefing, /Reliability matters/);
    assert.match(result.realtime_session_instructions, /Shared reasoning workspace briefing/);
    assert.match(result.realtime_session_instructions, /coordinate_reasoning_turn/);
    assert.equal(result.board_state.version, 0);
    assert.ok(result.whiteboard_job);
    assert.equal(result.whiteboard_job.sync_status, "pending");

    const jobs = await getJson(`${baseUrl}/board/jobs?client_session_id=commit-session`);
    assert.equal(jobs.jobs.length, 1);
    assert.equal(jobs.jobs[0].command.sync_reason, "committed_workspace_change");
    assert.equal(jobs.jobs[0].command.expected_workspace_version, result.workspace_state.version);
    assert.equal(jobs.jobs[0].command.workspace_context.active_entries.objectives[0].id, "objective-reliability");

    const logs = await getJson(`${baseUrl}/logs/session?client_session_id=commit-session`);
    assert.ok(logs.events.some((event) => event.category === "tool" && event.action === "execute" && event.status === "completed"));
    assert.ok(logs.events.some((event) => event.category === "whiteboard_job" && event.action === "queued"));
    assert.ok(logs.events.every((event) => event.source_type === "test"));
  });
});

test("coordinate_reasoning_turn falls back to spoken_context when user goal and utterance are absent", async () => {
  await withServer(async (baseUrl) => {
    let updateUtterance = "";
    let responseUtterance = "";
    setReasoningCoordinatorOptionsForTest({
      updateProvider: async (modelInput) => {
        updateUtterance = modelInput.utterance;
        return {
          action: "update",
          operations: [{
            type: "update_working_memory",
            summary: modelInput.utterance,
            current_topic: "Launch path comparison",
          }],
          spoken_commit_notice: "I captured the launch path context.",
        };
      },
      responseProvider: async (modelInput) => {
        responseUtterance = modelInput.utterance;
        return {
          spoken_summary: "I captured the launch path context.",
          full_response: "The workspace now tracks the launch path comparison.",
          reasoning_summary: "Grounded in the spoken context fallback.",
          uncertainties: [],
          next_examination: "",
        };
      },
      routeProvider: async () => conversationalDecision(),
    });

    const result = await postJson(baseUrl, "/tools/execute", {
      name: "coordinate_reasoning_turn",
      client_session_id: "spoken-context-session",
      arguments: {
        spoken_context: "Compare enterprise pilots with self-serve launch.",
        conversation_summary: "",
        visible_board_context: "",
        user_preference: "",
        response_mode: "short_answer",
        turn_id: "turn-spoken-context",
      },
    });

    assert.equal(result.handled_by, "turn_coordinator");
    assert.equal(result.action, "update");
    assert.equal(updateUtterance, "Compare enterprise pilots with self-serve launch.");
    assert.equal(responseUtterance, "Compare enterprise pilots with self-serve launch.");
    assert.equal(result.workspace_state.working_memory.summary, "Compare enterprise pilots with self-serve launch.");
  });
});

test("coordinate_reasoning_turn recovers from conversation summary when current-turn fields are absent", async () => {
  await withServer(async (baseUrl) => {
    let updateUtterance = "";
    setReasoningCoordinatorOptionsForTest({
      updateProvider: async (modelInput) => {
        updateUtterance = modelInput.utterance;
        return {
          action: "update",
          operations: [{
            type: "update_working_memory",
            summary: modelInput.utterance,
            current_topic: "Launch path comparison",
          }],
          spoken_commit_notice: "I recovered the turn from the conversation summary.",
        };
      },
      responseProvider: async () => ({
        spoken_summary: "I captured the launch path comparison.",
        full_response: "",
        reasoning_summary: "",
        uncertainties: [],
        next_examination: "",
      }),
      routeProvider: async () => conversationalDecision(),
    });

    const result = await postJson(baseUrl, "/tools/execute", {
      name: "coordinate_reasoning_turn",
      client_session_id: "summary-fallback-session",
      arguments: {
        conversation_summary: "The user is comparing enterprise pilots with self-serve launch.",
        visible_board_context: "",
        user_preference: "",
        response_mode: "short_answer",
        turn_id: "turn-summary-fallback",
      },
    });

    assert.equal(result.handled_by, "turn_coordinator");
    assert.equal(result.action, "update");
    assert.equal(updateUtterance, "The user is comparing enterprise pilots with self-serve launch.");

    const logs = await getJson(`${baseUrl}/logs/session?client_session_id=summary-fallback-session`);
    assert.ok(logs.events.some((event) => event.category === "frontend" && event.action === "invalid_tool_arguments"));
  });
});

test("coordinate_reasoning_turn empty arguments ask for clarification instead of failing", async () => {
  await withServer(async (baseUrl) => {
    let updateCalled = false;
    setReasoningCoordinatorOptionsForTest({
      updateProvider: async () => {
        updateCalled = true;
        return {
          action: "update",
          operations: [],
        };
      },
    });

    const result = await postJson(baseUrl, "/tools/execute", {
      name: "coordinate_reasoning_turn",
      client_session_id: "empty-args-session",
      arguments: {},
    });

    assert.equal(updateCalled, false);
    assert.equal(result.handled_by, "turn_coordinator");
    assert.equal(result.action, "clarify");
    assert.equal(result.board_sync_required, false);
    assert.equal(result.whiteboard_job, null);

    const logs = await getJson(`${baseUrl}/logs/session?client_session_id=empty-args-session`);
    assert.ok(logs.events.some((event) => event.category === "frontend" && event.action === "invalid_tool_arguments"));
    assert.ok(logs.events.some((event) => event.category === "tool" && event.action === "execute" && event.status === "completed"));
  });
});

test("workspace state is isolated per client_session_id", async () => {
  await withServer(async (baseUrl) => {
    setReasoningCoordinatorOptionsForTest({
      updateProvider: async () => ({
        action: "update",
        operations: [{
          type: "add_entry",
          id: "decision-alpha",
          category: "decisions",
          content: "Use alpha for this session",
          origin: "user_stated",
          source_turn_id: "turn-alpha",
        }],
      }),
      responseProvider: async () => ({ spoken_summary: "Saved alpha." }),
      routeProvider: async () => conversationalDecision(),
    });

    await postJson(baseUrl, "/tools/execute", coordinateBody(
      "session-alpha",
      "turn-alpha",
      "Use alpha for this session."
    ));

    const alpha = await getJson(`${baseUrl}/workspace/state?client_session_id=session-alpha`);
    const beta = await getJson(`${baseUrl}/workspace/state?client_session_id=session-beta`);

    assert.equal(alpha.entries.length, 1);
    assert.equal(alpha.entries[0].id, "decision-alpha");
    assert.equal(beta.version, 0);
    assert.deepEqual(beta.entries, []);
  });
});

test("coordinate_reasoning_turn response failure keeps workspace current and queues board sync", async () => {
  await withServer(async (baseUrl) => {
    setReasoningCoordinatorOptionsForTest({
      updateProvider: async () => ({
        action: "update",
        operations: [{
          type: "add_entry",
          id: "constraint-reliability",
          category: "constraints",
          content: "Reliability is required",
          origin: "user_stated",
          source_turn_id: "turn-response-fails",
        }],
      }),
      responseProvider: async () => {
        throw new Error("reasoner unavailable");
      },
      routeProvider: async () => conversationalDecision(),
    });

    const result = await postJson(baseUrl, "/tools/execute", coordinateBody(
      "response-failure-session",
      "turn-response-fails",
      "Reliability is required."
    ));

    assert.equal(result.response_error, "reasoner unavailable");
    assert.equal(result.spoken_summary, "I captured the reasoning update, but I could not complete the deeper analysis yet.");
    assert.equal(result.workspace_state.entries[0].id, "constraint-reliability");
    assert.equal(result.workspace_state.entries[0].status, "active");
    assert.equal(result.whiteboard_job.sync_status, "pending");
    assert.equal(result.whiteboard_job.workspace_sync, true);

    const state = await getJson(`${baseUrl}/workspace/state?client_session_id=response-failure-session`);
    assert.equal(state.entries[0].id, "constraint-reliability");
  });
});

test("workspace undo reverses committed memory and queues board sync only on success", async () => {
  await withServer(async (baseUrl) => {
    setReasoningCoordinatorOptionsForTest({
      updateProvider: async () => ({
        action: "update",
        operations: [{
          type: "add_entry",
          id: "assumption-budget",
          category: "assumptions",
          content: "Budget is already approved",
          origin: "ai_inferred",
          source_turn_id: "turn-budget",
        }],
      }),
      responseProvider: async () => ({ spoken_summary: "Saved the budget assumption." }),
      routeProvider: async () => conversationalDecision(),
    });

    await postJson(baseUrl, "/tools/execute", coordinateBody(
      "undo-session",
      "turn-budget",
      "Budget is already approved."
    ));

    const undo = await postJson(baseUrl, "/workspace/undo", {
      client_session_id: "undo-session",
    });
    assert.equal(undo.ok, true);
    assert.equal(undo.board_sync_required, true);
    assert.ok(undo.whiteboard_job);
    assert.equal(undo.whiteboard_job.sync_status, "pending");
    assert.equal(undo.workspace_state.entries.length, 0);
    assert.match(undo.workspace_briefing, /Reasoning undo available: no/);

    const state = await getJson(`${baseUrl}/workspace/state?client_session_id=undo-session`);
    assert.equal(state.entries.length, 0);
    assert.equal(state.can_undo, false);

    const jobs = await getJson(`${baseUrl}/board/jobs?client_session_id=undo-session`);
    assert.equal(jobs.jobs.length, 2);
    assert.equal(jobs.jobs[1].command.sync_reason, "reasoning_undo");
    assert.equal(jobs.jobs[1].command.expected_workspace_version, undo.workspace_state.version);

    const secondUndo = await postJson(baseUrl, "/workspace/undo", {
      client_session_id: "undo-session",
    });
    assert.equal(secondUndo.ok, false);
    assert.equal(secondUndo.board_sync_required, false);
    assert.equal(secondUndo.whiteboard_job, null);

    const jobsAfterFailedUndo = await getJson(`${baseUrl}/board/jobs?client_session_id=undo-session`);
    assert.equal(jobsAfterFailedUndo.jobs.length, 2);
  });
});
