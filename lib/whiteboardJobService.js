const { applyBoardOperations, getBoardSnapshot } = require("./boardState");
const { normalizeWhiteboardCommand, planOperationsForCommand } = require("./whiteboardCommandService");

function recordEvent(options = {}, event = {}) {
  const recorder = options.recorder;
  if (!recorder || typeof recorder.recordEvent !== "function") {
    return null;
  }

  try {
    const result = recorder.recordEvent({
      session_id: options.sessionId || options.session_id || "default",
      trace_id: options.traceId || options.trace_id,
      ...event,
    });

    if (result && typeof result.then === "function") {
      result.catch(() => {});
    }

    return result;
  } catch {
    return null;
  }
}

function ensureJobStore(sessionState) {
  if (!Array.isArray(sessionState.whiteboard_jobs)) {
    sessionState.whiteboard_jobs = [];
  }
  return sessionState.whiteboard_jobs;
}

function makeJobId() {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function serializeJob(job) {
  return {
    job_id: job.job_id,
    status: job.status,
    spoken_ack: job.spoken_ack,
    spoken_summary: job.spoken_summary || "",
    reasoning_summary: job.reasoning_summary || "",
    error: job.error || "",
    warnings: job.warnings || [],
    command: job.command,
    target_resolution: job.target_resolution || null,
    board_operations: job.board_operations || [],
    board_state: job.board_state || null,
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
    spoken_ack: options.spokenAck || "I’ll update the board now.",
    command,
    warnings: [],
    board_operations: [],
    created_at: now,
    updated_at: now,
  };
  jobs.push(job);
  recordEvent(options, {
    category: "whiteboard_job",
    action: "queued",
    status: "started",
    summary: "queued whiteboard job",
    payload: {
      job: serializeJob(job),
    },
  });

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
    recordEvent(options, {
      category: "whiteboard_job",
      action: "planning",
      status: "started",
      summary: "planning whiteboard job",
      payload: {
        job: serializeJob(job),
      },
    });

    const plan = await planOperationsForCommand(job.command, sessionState.board, {
      selected_item: sessionState.selected_item,
      recently_moved_item: sessionState.recently_moved_item,
      recorder: options.recorder,
      sessionId: options.sessionId,
      session_id: options.session_id,
      traceId: options.traceId,
      trace_id: options.trace_id,
      plannerOptions: {
        ...(options.plannerOptions || {}),
        recorder: options.recorder,
        sessionId: options.sessionId,
        session_id: options.session_id,
        traceId: options.traceId,
        trace_id: options.trace_id,
      },
    });

    job.target_resolution = plan.target_resolution || null;
    job.spoken_summary = plan.spoken_summary || "";
    job.reasoning_summary = plan.reasoning_summary || "";
    job.warnings = plan.warnings || [];
    job.board_operations = plan.board_operations || [];

    if (plan.status === "needs_clarification") {
      job.status = "needs_clarification";
      job.board_state = getBoardSnapshot(sessionState.board);
      job.updated_at = new Date().toISOString();
      recordEvent(options, {
        category: "whiteboard_job",
        action: "needs_clarification",
        status: "warning",
        summary: "whiteboard job needs clarification",
        payload: {
          job: serializeJob(job),
        },
      });
      return job;
    }

    if (!job.board_operations.length) {
      job.status = "failed";
      job.error = "Planner returned no valid board operations.";
      job.board_state = getBoardSnapshot(sessionState.board);
      job.updated_at = new Date().toISOString();
      recordEvent(options, {
        category: "whiteboard_job",
        action: "failed",
        status: "failed",
        summary: "whiteboard job failed",
        payload: {
          job: serializeJob(job),
        },
      });
      return job;
    }

    if ((plan.warnings || []).length && options.plannerOptions?.disableFallback) {
      job.status = "failed";
      job.error = `Planner returned invalid operations: ${plan.warnings.join(" ")}`;
      job.board_state = getBoardSnapshot(sessionState.board);
      job.updated_at = new Date().toISOString();
      recordEvent(options, {
        category: "whiteboard_job",
        action: "failed",
        status: "failed",
        summary: "whiteboard job failed after planner warnings",
        payload: {
          job: serializeJob(job),
        },
      });
      return job;
    }

    job.status = "applying";
    recordEvent(options, {
      category: "whiteboard_job",
      action: "applying",
      status: "started",
      summary: "applying whiteboard job operations",
      payload: {
        job: serializeJob(job),
        warnings: job.warnings,
      },
    });
    const applied = applyBoardOperations(sessionState.board, job.board_operations, {
      source: "ai",
      job_id: job.job_id,
    });
    job.status = "completed";
    job.undo_checkpoint_id = applied.undo_checkpoint_id;
    job.board_state = applied.board_state;
    job.updated_at = new Date().toISOString();
    recordEvent(options, {
      category: "whiteboard_job",
      action: "completed",
      status: "completed",
      summary: "completed whiteboard job",
      payload: {
        job: serializeJob(job),
        warnings: job.warnings,
      },
    });
    return job;
  } catch (error) {
    job.status = "failed";
    job.error = error.message;
    job.board_state = getBoardSnapshot(sessionState.board);
    job.updated_at = new Date().toISOString();
    recordEvent(options, {
      category: "whiteboard_job",
      action: "failed",
      status: "failed",
      summary: "whiteboard job failed",
      payload: {
        job: serializeJob(job),
        error: error.message,
      },
    });
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
