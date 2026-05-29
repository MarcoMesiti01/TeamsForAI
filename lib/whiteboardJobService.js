const { applyBoardOperations, getBoardSnapshot } = require("./boardState");
const { normalizeWhiteboardCommand, planOperationsForCommand } = require("./whiteboardCommandService");

function ensureJobStore(sessionState) {
  if (!Array.isArray(sessionState.whiteboard_jobs)) {
    sessionState.whiteboard_jobs = [];
  }
  return sessionState.whiteboard_jobs;
}

function makeJobId() {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function serializeJob(job) {
  return {
    job_id: job.job_id,
    status: job.status,
    sync_status: job.sync_status || "pending",
    spoken_ack: job.spoken_ack,
    spoken_summary: job.spoken_summary || "",
    reasoning_summary: job.reasoning_summary || "",
    error: job.error || "",
    warnings: clone(job.warnings || []),
    command: clone(job.command),
    target_resolution: clone(job.target_resolution || null),
    board_operations: clone(job.board_operations || []),
    board_state: clone(job.board_state || null),
    undo_checkpoint_id: job.undo_checkpoint_id || null,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function createWhiteboardJob(sessionState, commandInput, options = {}) {
  const jobs = ensureJobStore(sessionState);
  const command = normalizeWhiteboardCommand(commandInput);
  const now = new Date().toISOString();
  const job = {
    job_id: makeJobId(),
    status: "queued",
    sync_status: "pending",
    spoken_ack: options.spokenAck || "I’ll update the board now.",
    command,
    warnings: [],
    board_operations: [],
    created_at: now,
    updated_at: now,
  };
  jobs.push(job);

  if (options.autoStart !== false) {
    setTimeout(() => {
      void runWhiteboardJob(sessionState, job.job_id, options).catch(() => {});
    }, 0);
  }

  return job;
}

function getWhiteboardJob(sessionState, jobId) {
  return ensureJobStore(sessionState).find((job) => job.job_id === jobId) || null;
}

async function runWhiteboardJob(sessionState, jobId, options = {}) {
  const job = getWhiteboardJob(sessionState, jobId);
  if (!job) {
    throw new Error(`Unknown whiteboard job: ${jobId}`);
  }
  if (job.status === "completed") return job;

  try {
    job.status = "planning";
    job.updated_at = new Date().toISOString();

    const plan = await planOperationsForCommand(job.command, sessionState.board, {
      selected_item: sessionState.selected_item,
      recently_moved_item: sessionState.recently_moved_item,
      plannerOptions: options.plannerOptions || {},
    });

    job.target_resolution = plan.target_resolution || null;
    job.spoken_summary = plan.spoken_summary || "";
    job.reasoning_summary = plan.reasoning_summary || "";
    job.warnings = plan.warnings || [];
    job.board_operations = plan.board_operations || [];

    if (plan.status === "needs_clarification") {
      job.status = "needs_clarification";
      job.sync_status = "pending";
      job.board_state = getBoardSnapshot(sessionState.board);
      job.updated_at = new Date().toISOString();
      return job;
    }

    if (!job.board_operations.length) {
      job.status = "failed";
      job.sync_status = "failed";
      job.error = "Planner returned no valid board operations.";
      job.board_state = getBoardSnapshot(sessionState.board);
      job.updated_at = new Date().toISOString();
      return job;
    }

    if ((plan.warnings || []).length && options.plannerOptions?.disableFallback) {
      job.status = "failed";
      job.sync_status = "failed";
      job.error = `Planner returned invalid operations: ${plan.warnings.join(" ")}`;
      job.board_state = getBoardSnapshot(sessionState.board);
      job.updated_at = new Date().toISOString();
      return job;
    }

    job.status = "applying";
    const applied = applyBoardOperations(sessionState.board, job.board_operations, {
      source: "ai",
      job_id: job.job_id,
    });
    job.status = "completed";
    job.sync_status = "synchronized";
    job.undo_checkpoint_id = applied.undo_checkpoint_id;
    job.board_state = applied.board_state;
    job.updated_at = new Date().toISOString();
    return job;
  } catch (error) {
    job.status = "failed";
    job.sync_status = "failed";
    job.error = error.message;
    job.board_state = getBoardSnapshot(sessionState.board);
    job.updated_at = new Date().toISOString();
    return job;
  }
}

function listWhiteboardJobs(sessionState) {
  return ensureJobStore(sessionState).map(serializeJob);
}

module.exports = {
  createWhiteboardJob,
  getWhiteboardJob,
  runWhiteboardJob,
  listWhiteboardJobs,
};
