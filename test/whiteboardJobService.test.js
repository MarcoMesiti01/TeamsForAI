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
  assert.equal(job.sync_status, "pending");
  assert.equal(typeof job.job_id, "string");
  assert.match(job.spoken_ack, /update the board/i);
  assert.equal(listWhiteboardJobs(state).length, 1);
  assert.equal(listWhiteboardJobs(state)[0].sync_status, "pending");
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
  assert.equal(job.sync_status, "synchronized");
  assert.equal(listWhiteboardJobs(state)[0].sync_status, "synchronized");
  assert.equal(job.board_state.nodes.length > 0, true);
  assert.equal(state.board.undo_stack.length, 1);
  assert.equal(typeof job.undo_checkpoint_id, "string");
});

test("failed planner output marks job failed and leaves board unchanged", async () => {
  const state = { board: createBoardState(), whiteboard_jobs: [] };
  const job = createWhiteboardJob(state, {
    command_type: "create_artifact",
    artifact_type: "idea_map",
    user_goal: "Create invalid board",
  }, { autoStart: false });

  await runWhiteboardJob(state, job.job_id, {
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
  assert.equal(job.sync_status, "failed");
  assert.equal(listWhiteboardJobs(state)[0].sync_status, "failed");
  assert.equal(state.board.nodes.length, 0);
  assert.match(job.error, /invalid operations/i);
});

test("needs-clarification job leaves synchronization pending and board unchanged", async () => {
  const state = { board: createBoardState(), whiteboard_jobs: [] };
  const job = createWhiteboardJob(state, {
    command_type: "delete_item",
    user_goal: "Maybe delete something",
    target_confidence: 0.3,
    allow_destructive: true,
  }, { autoStart: false });

  await runWhiteboardJob(state, job.job_id);

  assert.equal(job.status, "needs_clarification");
  assert.equal(job.sync_status, "pending");
  assert.equal(state.board.nodes.length, 0);
});
