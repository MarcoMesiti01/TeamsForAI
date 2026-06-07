const test = require("node:test");
const assert = require("node:assert/strict");

const { createBoardState } = require("../lib/boardState");
const {
  createWhiteboardJob,
  runWhiteboardJob,
  listWhiteboardJobs,
} = require("../lib/whiteboardJobService");

test("submitting a whiteboard command creates a queued job with immediate acknowledgement", () => {
  const state = { board: createBoardState(), whiteboard_jobs: [] };
  const job = createWhiteboardJob(state, {
    command_type: "create_artifact",
    artifact_type: "process_flow",
    user_goal: "Describe onboarding",
    change_description: "Show onboarding steps",
  }, { autoStart: false });

  assert.equal(job.status, "queued");
  assert.equal(typeof job.job_id, "string");
  assert.match(job.spoken_ack, /update the board/i);
  assert.equal(listWhiteboardJobs(state).length, 1);
});

test("completed whiteboard job applies one undoable board checkpoint", async () => {
  const state = { board: createBoardState(), whiteboard_jobs: [] };
  const job = createWhiteboardJob(state, {
    command_type: "create_artifact",
    artifact_type: "process_flow",
    user_goal: "Describe onboarding",
    target_confidence: 0.9,
  }, { autoStart: false });

  await runWhiteboardJob(state, job.job_id, { plannerOptions: { apiKey: "" } });

  assert.equal(job.status, "completed");
  assert.equal(job.board_state.nodes.length > 0, true);
  assert.equal(state.board.undo_stack.length, 1);
  assert.equal(typeof job.undo_checkpoint_id, "string");
});

test("failed planner output marks job failed and leaves board unchanged", async () => {
  const events = [];
  const recorder = {
    recordEvent(event) {
      events.push(event);
    },
  };
  const state = { board: createBoardState(), whiteboard_jobs: [] };
  const job = createWhiteboardJob(state, {
    command_type: "create_artifact",
    artifact_type: "idea_map",
    user_goal: "Create invalid board",
  }, { autoStart: false, recorder, sessionId: "session-failed", traceId: "trace-failed" });

  await runWhiteboardJob(state, job.job_id, {
    recorder,
    sessionId: "session-failed",
    traceId: "trace-failed",
    plannerOptions: {
      plannerProvider: async () => ({
        spoken_summary: "Bad plan",
        reasoning_summary: "Invalid edge",
        layout_notes: "",
        missing_info: [],
        board_operations: [
          { type: "create_edge", id: "edge-bad", from: "missing-a", to: "missing-b", label: "bad" },
        ],
      }),
      disableFallback: true,
    },
  });

  assert.equal(job.status, "failed");
  assert.equal(state.board.nodes.length, 0);
  assert.match(job.error, /invalid operations/i);
  assert.ok(events.some((event) => event.category === "whiteboard_job" && event.action === "failed" && event.status === "failed"));
});

test("destructive low confidence jobs request clarification", async () => {
  const events = [];
  const recorder = {
    recordEvent(event) {
      events.push(event);
    },
  };
  const state = { board: createBoardState(), whiteboard_jobs: [] };
  const job = createWhiteboardJob(state, {
    command_type: "delete_item",
    artifact_type: "idea_map",
    user_goal: "Remove the main idea",
    target_selector: { text: "Main idea" },
    target_confidence: 0.2,
    allow_destructive: true,
  }, { autoStart: false, recorder, sessionId: "session-clarify", traceId: "trace-clarify" });

  await runWhiteboardJob(state, job.job_id, {
    recorder,
    sessionId: "session-clarify",
    traceId: "trace-clarify",
    plannerOptions: {
      plannerProvider: async () => ({
        spoken_summary: "Need clarification",
        reasoning_summary: "Invalid request",
        layout_notes: "",
        missing_info: [],
        board_operations: [],
      }),
    },
  });

  assert.equal(job.status, "needs_clarification");
  assert.ok(events.some((event) => event.category === "whiteboard_job" && event.action === "needs_clarification" && event.status === "warning"));
});

test("whiteboard jobs emit lifecycle events", async () => {
  const events = [];
  const recorder = {
    recordEvent(event) {
      events.push(event);
    },
  };
  const state = { board: createBoardState(), whiteboard_jobs: [] };
  const job = createWhiteboardJob(state, {
    command_type: "create_artifact",
    artifact_type: "process_flow",
    user_goal: "Describe onboarding",
    target_confidence: 0.9,
  }, { autoStart: false, recorder, sessionId: "session-123", traceId: "trace-abc" });

  await runWhiteboardJob(state, job.job_id, {
    recorder,
    sessionId: "session-123",
    traceId: "trace-abc",
    plannerOptions: {
      plannerProvider: async () => ({
        spoken_summary: "I added a process map.",
        reasoning_summary: "The board was empty, so I created a starter flow.",
        layout_notes: "Nodes are spaced horizontally with a readable edge.",
        missing_info: [],
        board_operations: [
          { type: "create_node", id: "node-1", text: "Start", x: 120, y: 90 },
        ],
      }),
    },
  });

  assert.ok(events.some((event) => event.category === "whiteboard_job" && event.action === "queued" && event.status === "started"));
  assert.ok(events.some((event) => event.category === "whiteboard_job" && event.action === "planning" && event.status === "started"));
  assert.ok(events.some((event) => event.category === "whiteboard_job" && event.action === "applying" && event.status === "started"));
  assert.ok(events.some((event) => event.category === "whiteboard_job" && event.action === "completed" && event.status === "completed"));
  assert.ok(events.every((event) => event.category !== "whiteboard_job" || ["queued", "planning", "applying", "completed", "failed", "needs_clarification"].includes(event.action)));
  assert.ok(events.every((event) => event.session_id === "session-123"));
  assert.ok(events.every((event) => event.trace_id === "trace-abc"));
});
