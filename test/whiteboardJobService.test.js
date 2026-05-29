const test = require("node:test");
const assert = require("node:assert/strict");

const { createBoardState, applyBoardOperations, getBoardSnapshot } = require("../lib/boardState");
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
  applyBoardOperations(state.board, [
    { type: "create_node", id: "node-existing", text: "Existing idea", x: 120, y: 80 },
  ]);
  const boardSnapshotBeforeFailure = getBoardSnapshot(state.board);
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
  assert.deepEqual(getBoardSnapshot(state.board), boardSnapshotBeforeFailure);
  assert.deepEqual(job.board_state, boardSnapshotBeforeFailure);
  assert.match(job.error, /invalid operations/i);
});

test("planner provider mutations cannot leak into job command or original workspace metadata", async () => {
  const state = { board: createBoardState(), whiteboard_jobs: [] };
  const workspaceContext = {
    active_entries: {
      options: [{ id: "option-canary", content: "Use canary rollout", status: "committed" }],
    },
  };
  const job = createWhiteboardJob(state, {
    command_type: "create_artifact",
    artifact_type: "idea_map",
    user_goal: "Project committed workspace",
    workspace_context: workspaceContext,
  }, { autoStart: false });

  await runWhiteboardJob(state, job.job_id, {
    plannerOptions: {
      plannerProvider: async (input) => {
        input.workspace_context.active_entries.options[0].content = "Mutated inside provider";
        input.workspace_context.active_entries.options.push({ id: "option-new", content: "New provider option" });
        return {
          spoken_summary: "Projected workspace",
          reasoning_summary: "Created a node for the committed option.",
          layout_notes: "Single node",
          missing_info: [],
          board_operations: [
            { type: "create_node", id: "node-option", text: "Use canary rollout", x: 120, y: 90 },
          ],
        };
      },
    },
  });

  assert.deepEqual(job.command.workspace_context, {
    active_entries: {
      options: [{ id: "option-canary", content: "Use canary rollout", status: "committed" }],
    },
  });
  assert.deepEqual(workspaceContext, {
    active_entries: {
      options: [{ id: "option-canary", content: "Use canary rollout", status: "committed" }],
    },
  });
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
