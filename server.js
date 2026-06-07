const path = require("path");
const express = require("express");
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });
const { defaultEventRecorder } = require("./lib/eventRecorder");
const { delegateToBrain } = require("./lib/brainService");
const { routeUserIntent } = require("./lib/intentRouter");
const { createBoardState, applyBoardOperations, getBoardSnapshot, undoLastCheckpoint } = require("./lib/boardState");
const { buildWhiteboardCommandFromIntent } = require("./lib/whiteboardCommandService");
const { createWhiteboardJob, listWhiteboardJobs } = require("./lib/whiteboardJobService");
const { MODEL_ROLES, selectModel } = require("./lib/modelPolicy");

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const sessionStateStore = new Map();
const REALTIME_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"]);

function nowMs() {
  return Date.now();
}

function durationMs(startedAt) {
  return Number.isFinite(startedAt) ? Math.max(0, nowMs() - startedAt) : null;
}

function recordEvent(event) {
  return defaultEventRecorder.recordEvent(event);
}

function makeTraceId(prefix = "trace") {
  return defaultEventRecorder.makeTraceId(prefix);
}

function getSessionId(value) {
  return String(value || "default");
}

function logRouteEvent({ sessionId, traceId, category, action, status, summary, payload }) {
  return recordEvent({
    session_id: getSessionId(sessionId),
    trace_id: traceId || makeTraceId(category || "trace"),
    category,
    action,
    status,
    summary,
    payload,
  });
}

app.use(express.text({ type: ["application/sdp", "text/plain"] }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "delegate_to_orchestrator",
    description:
      "Send the user's intent-level goal and surrounding context to the backend orchestrator; it decides whether to answer, clarify, use persistent board context, or invoke downstream tools.",
    parameters: {
      type: "object",
      properties: {
        user_goal: {
          type: "string",
          description: "The user's current objective or intent in plain language.",
        },
        spoken_context: {
          type: "string",
          description: "Relevant details from the current spoken turn, including constraints, references, and uncertainty.",
        },
        conversation_summary: {
          type: "string",
          description: "Compact summary of prior conversation needed to interpret this turn.",
        },
        visible_board_context: {
          type: "string",
          description: "Brief description of board content or visible shared context the user appears to reference.",
        },
        user_preference: {
          type: "string",
          description: "Any stated preference about format, tone, depth, ordering, or interaction style.",
        },
        response_mode: {
          type: "string",
          description: "Desired response style, such as short_answer, brief_clarification, board_artifact, full_text, or tool_instructions.",
        },
        candidate_artifact_type: {
          type: "string",
          description: "Optional likely artifact type if the user implied one, such as idea_map, plan, comparison, diagram, board, or conversation.",
        },
      },
      required: [
        "user_goal",
        "spoken_context",
        "conversation_summary",
        "visible_board_context",
        "user_preference",
        "response_mode",
      ],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "submit_whiteboard_command",
    description:
      "Queue a typed whiteboard command without blocking speech. Use for direct board edits: create, modify, connect, group, reorganize, emphasize, move, or delete.",
    parameters: {
      type: "object",
      properties: {
        command_type: {
          type: "string",
          description: "create_artifact, modify_item, move_item, connect_items, group_items, reorganize_artifact, emphasize_item, delete_item, or replace_artifact.",
        },
        artifact_type: {
          type: "string",
          description: "idea_map, process_flow, architecture_map, comparison_map, action_plan, or board.",
        },
        user_goal: { type: "string" },
        target_selector: {
          type: "object",
          additionalProperties: true,
        },
        target_confidence: { type: "number" },
        change_description: { type: "string" },
        constraints: {
          type: "object",
          additionalProperties: true,
        },
        allow_destructive: { type: "boolean" },
      },
      required: ["command_type", "artifact_type", "user_goal", "target_selector", "target_confidence", "change_description", "constraints", "allow_destructive"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "undo_board_operation",
    description: "Undo the last applied board operation checkpoint.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

const TOOLING_INSTRUCTIONS = [
  "You are the realtime controller assistant.",
  "Your job is low-latency voice UX: turn-taking, interruptions, and concise spoken replies.",
  "Answer directly for short conversational responses, greetings, and simple factual replies that do not need persistent shared context.",
  "Call delegate_to_orchestrator when the user is externalizing thought, comparing options, designing, planning, mapping relationships, or needs persistent shared context.",
  "Call submit_whiteboard_command directly when the user gives a specific board edit, such as changing, connecting, moving, grouping, emphasizing, or deleting a board item.",
  "For board work, acknowledge quickly; the backend queues the visual update and the browser shows it when ready.",
  "Ask a brief clarification yourself when the artifact goal is ambiguous enough that delegation would not have a clear target.",
  "Do not decide board layout, whiteboard structure, or spatial placement yourself; pass intent-level context to the orchestrator instead.",
  "Keep undo_board_operation as a direct deterministic UI action, and call it when the user asks to undo, go back, or revert the last board change.",
  "When the brain returns, present the spoken_summary briefly and do not narrate raw JSON.",
].join(" ");

function getSessionState(clientSessionId) {
  const existing = sessionStateStore.get(clientSessionId);
  if (existing) return existing;

  const state = {
    last_task_type: "general",
    last_user_goal: "",
    board: createBoardState(),
    selected_item: null,
    recently_moved_item: null,
  };
  sessionStateStore.set(clientSessionId, state);
  return state;
}

app.post("/session", async (req, res) => {
  const startedAt = nowMs();
  const traceId = makeTraceId("session");
  try {
    logRouteEvent({
      traceId,
      category: "session",
      action: "create",
      status: "started",
      summary: "Realtime session request started.",
      payload: {
        model_override: String(req.query?.model || "").trim() || null,
        voice: String(req.query?.voice || "").trim() || null,
      },
    });

    if (!OPENAI_API_KEY) {
      logRouteEvent({
        traceId,
        category: "session",
        action: "create",
        status: "failed",
        summary: "Missing OPENAI_API_KEY in environment.",
        payload: {
          duration_ms: durationMs(startedAt),
        },
      });
      return res.status(500).json({
        error: "Missing OPENAI_API_KEY in environment.",
      });
    }

    const sdpOffer = typeof req.body === "string" ? req.body : "";
    const sdpPreview = sdpOffer.split(/\r?\n/, 1)[0] || "";
    if (!sdpOffer.trim()) {
      logRouteEvent({
        traceId,
        category: "session",
        action: "validate_sdp",
        status: "failed",
        summary: "Missing WebRTC SDP offer.",
        payload: {
          content_type: req.get("content-type") || "",
          content_length: req.get("content-length") || "",
          body_type: typeof req.body,
          duration_ms: durationMs(startedAt),
        },
      });
      return res.status(400).json({
        error: "Missing WebRTC SDP offer.",
        debug: {
          content_type: req.get("content-type") || "",
          content_length: req.get("content-length") || "",
          body_type: typeof req.body,
        },
      });
    }

    if (!sdpOffer.startsWith("v=0")) {
      logRouteEvent({
        traceId,
        category: "session",
        action: "validate_sdp",
        status: "failed",
        summary: "Invalid WebRTC SDP offer.",
        payload: {
          sdp_length: sdpOffer.length,
          sdp_first_line: sdpPreview,
          content_type: req.get("content-type") || "",
          content_length: req.get("content-length") || "",
          duration_ms: durationMs(startedAt),
        },
      });
      return res.status(400).json({
        error: "Invalid WebRTC SDP offer: expected the body to start with v=0.",
        debug: {
          sdp_length: sdpOffer.length,
          sdp_first_line: sdpPreview,
          content_type: req.get("content-type") || "",
          content_length: req.get("content-length") || "",
        },
      });
    }

    const frontendModelOverride = String(req.query?.model || "").trim();
    const requestedVoice = String(req.query?.voice || "").trim();
    const selectedVoice = REALTIME_VOICES.has(requestedVoice) ? requestedVoice : "alloy";
    const selectedModel = frontendModelOverride || selectModel({
      role: MODEL_ROLES.realtime_controller,
      complexity: "low",
      latency_budget: "realtime",
      artifact_type: "conversation",
    }).model;

    logRouteEvent({
      traceId,
      category: "session",
      action: "select_model",
      status: "info",
      summary: "Selected realtime model and voice.",
      payload: {
        model: selectedModel,
        voice: selectedVoice,
        overridden: Boolean(frontendModelOverride),
      },
    });

    const sessionConfig = JSON.stringify({
      type: "realtime",
      model: selectedModel,
      audio: { output: { voice: selectedVoice } },
      tools: TOOL_DEFINITIONS,
      instructions: TOOLING_INSTRUCTIONS,
    });
    const formData = new FormData();
    formData.set("sdp", sdpOffer);
    formData.set("session", sessionConfig);

    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: formData,
    });

    const responseText = await response.text();

    if (!response.ok) {
      logRouteEvent({
        traceId,
        category: "session",
        action: "create_realtime_call",
        status: "failed",
        summary: "Failed to create realtime call.",
        payload: {
          status: response.status,
          duration_ms: durationMs(startedAt),
        },
      });
      return res.status(response.status).json({
        error: "Failed to create realtime call.",
        details: responseText,
        debug: {
          sdp_length: sdpOffer.length,
          sdp_first_line: sdpPreview,
          content_type: req.get("content-type") || "",
          content_length: req.get("content-length") || "",
        },
      });
    }

    logRouteEvent({
      traceId,
      category: "session",
      action: "create_realtime_call",
      status: "completed",
      summary: "Realtime session created.",
      payload: {
        model: selectedModel,
        voice: selectedVoice,
        duration_ms: durationMs(startedAt),
      },
    });

    res.setHeader("Content-Type", "application/sdp");
    res.setHeader("X-Realtime-Model", selectedModel);
    res.setHeader("X-Realtime-Voice", selectedVoice);
    return res.send(responseText);
  } catch (error) {
    logRouteEvent({
      traceId,
      category: "session",
      action: "create_realtime_call",
      status: "failed",
      summary: "Unexpected server error while creating realtime call.",
      payload: {
        error: error.message,
        duration_ms: durationMs(startedAt),
      },
    });
    return res.status(500).json({
      error: "Unexpected server error while creating realtime call.",
      details: error.message,
    });
  }
});

app.post("/tools/execute", async (req, res) => {
  const startedAt = nowMs();
  const traceId = makeTraceId("tool");
  try {
    const toolName = req.body?.name;
    const toolArgs = req.body?.arguments || {};
    const clientSessionId = req.body?.client_session_id || "default";

    logRouteEvent({
      sessionId: clientSessionId,
      traceId,
      category: "tool",
      action: "execute",
      status: "started",
      summary: "Tool execution started.",
      payload: {
        tool_name: toolName || null,
        duration_ms: durationMs(startedAt),
      },
    });

    if (!toolName) {
      logRouteEvent({
        sessionId: clientSessionId,
        traceId,
        category: "tool",
        action: "execute",
        status: "failed",
        summary: "Missing tool name.",
        payload: {
          duration_ms: durationMs(startedAt),
        },
      });
      return res.status(400).json({ ok: false, error: "Missing tool name." });
    }

    if (toolName === "delegate_to_orchestrator" || toolName === "route_user_intent" || toolName === "delegate_to_brain") {
      const state = getSessionState(clientSessionId);
      if (toolArgs.selected_item && typeof toolArgs.selected_item === "object") {
        state.selected_item = toolArgs.selected_item;
      }
      const intent = toolName === "delegate_to_brain"
        ? toolArgs
        : await routeUserIntent(toolArgs, {
            board: state.board,
            selected_item: state.selected_item,
            recently_moved_item: state.recently_moved_item,
            recorder: defaultEventRecorder,
            session_id: clientSessionId,
            trace_id: traceId,
          });
      if (toolName !== "delegate_to_brain" && intent.should_use_whiteboard === true) {
        const command = intent.board_command || buildWhiteboardCommandFromIntent(intent);
        const job = createWhiteboardJob(state, command, {
          recorder: defaultEventRecorder,
          session_id: clientSessionId,
          trace_id: traceId,
        });
        sessionStateStore.set(clientSessionId, state);
        const responseBody = {
          handled_by: "whiteboard_job",
          spoken_summary: job.spoken_ack,
          full_response: "Whiteboard update queued.",
          reasoning_summary: intent.reason,
          missing_info: [],
          board_operations: [],
          undo_checkpoint_id: null,
          intent,
          whiteboard_job: {
            job_id: job.job_id,
            status: job.status,
            spoken_ack: job.spoken_ack,
          },
          board_state: getBoardSnapshot(state.board),
        };
        logRouteEvent({
          sessionId: clientSessionId,
          traceId,
          category: "tool",
          action: "execute",
          status: "completed",
          summary: "Tool execution completed.",
          payload: {
            tool_name: toolName,
            response: responseBody,
            duration_ms: durationMs(startedAt),
          },
        });
        return res.json(responseBody);
      }
      const result = await delegateToBrain(intent, state, {
        recorder: defaultEventRecorder,
        session_id: clientSessionId,
        trace_id: traceId,
      });
      sessionStateStore.set(clientSessionId, state);
      const responseBody = {
        ...result,
        intent,
        board_state: result.board_state || getBoardSnapshot(state.board),
      };
      logRouteEvent({
        sessionId: clientSessionId,
        traceId,
        category: "tool",
        action: "execute",
        status: "completed",
        summary: "Tool execution completed.",
        payload: {
          tool_name: toolName,
          response: responseBody,
          duration_ms: durationMs(startedAt),
        },
      });
      return res.json(responseBody);
    }

    if (toolName === "submit_whiteboard_command") {
      const state = getSessionState(clientSessionId);
      const job = createWhiteboardJob(state, {
        ...toolArgs,
        user_goal: toolArgs.user_goal || toolArgs.change_description || "Update the whiteboard",
      }, {
        recorder: defaultEventRecorder,
        session_id: clientSessionId,
        trace_id: traceId,
      });
      sessionStateStore.set(clientSessionId, state);
      const responseBody = {
        handled_by: "whiteboard_job",
        spoken_summary: job.spoken_ack,
        full_response: "Whiteboard update queued.",
        reasoning_summary: "The realtime controller submitted a direct whiteboard command.",
        missing_info: [],
        board_operations: [],
        undo_checkpoint_id: null,
        whiteboard_job: {
          job_id: job.job_id,
          status: job.status,
          spoken_ack: job.spoken_ack,
        },
        board_state: getBoardSnapshot(state.board),
      };
      logRouteEvent({
        sessionId: clientSessionId,
        traceId,
        category: "tool",
        action: "execute",
        status: "completed",
        summary: "Tool execution completed.",
        payload: {
          tool_name: toolName,
          response: responseBody,
          duration_ms: durationMs(startedAt),
        },
      });
      return res.json(responseBody);
    }

    if (toolName === "undo_board_operation") {
      const state = getSessionState(clientSessionId);
      const undo = undoLastCheckpoint(state.board);
      const responseBody = {
        handled_by: "board",
        spoken_summary: undo.ok ? "I undid the last board change." : "There is nothing to undo yet.",
        full_response: undo.ok ? "Last checkpoint restored." : undo.error,
        reasoning_summary: "Undo restores the board snapshot from the previous checkpoint.",
        missing_info: [],
        board_operations: [{ type: "undo" }],
        undo_checkpoint_id: null,
        ...undo,
      };
      logRouteEvent({
        sessionId: clientSessionId,
        traceId,
        category: "tool",
        action: "execute",
        status: "completed",
        summary: "Tool execution completed.",
        payload: {
          tool_name: toolName,
          response: responseBody,
          duration_ms: durationMs(startedAt),
        },
      });
      return res.json(responseBody);
    }

    logRouteEvent({
      sessionId: clientSessionId,
      traceId,
      category: "tool",
      action: "execute",
      status: "failed",
      summary: `Unknown tool: ${toolName}`,
      payload: {
        duration_ms: durationMs(startedAt),
      },
    });
    return res.status(400).json({ ok: false, error: `Unknown tool: ${toolName}` });
  } catch (error) {
    const clientSessionId = req.body?.client_session_id || "default";
    logRouteEvent({
      sessionId: clientSessionId,
      traceId,
      category: "tool",
      action: "execute",
      status: "failed",
      summary: "Tool execution failed.",
      payload: {
        error: error.message,
        duration_ms: durationMs(startedAt),
      },
    });
    return res.status(500).json({
      ok: false,
      error: "Tool execution failed.",
      details: error.message,
    });
  }
});

app.get("/logs/session", (req, res) => {
  const clientSessionId = req.query?.client_session_id || "default";
  return res.json({
    ok: true,
    events: defaultEventRecorder.getSessionEvents(clientSessionId),
  });
});

app.post("/logs/client-event", (req, res) => {
  const clientSessionId = req.body?.client_session_id || "default";
  const event = recordEvent({
    session_id: clientSessionId,
    trace_id: req.body?.trace_id || makeTraceId("client"),
    category: req.body?.category || "frontend",
    action: req.body?.action || "client_event",
    status: req.body?.status || "info",
    summary: req.body?.summary || "Client event recorded.",
    payload: req.body?.payload,
  });
  return res.status(202).json({
    ok: true,
    event,
  });
});

app.get("/board/state", (req, res) => {
  const clientSessionId = req.query?.client_session_id || "default";
  const state = getSessionState(clientSessionId);
  return res.json(getBoardSnapshot(state.board));
});

app.post("/board/commands", (req, res) => {
  const startedAt = nowMs();
  const traceId = makeTraceId("board");
  try {
    const clientSessionId = req.body?.client_session_id || "default";
    logRouteEvent({
      sessionId: clientSessionId,
      traceId,
      category: "board",
      action: "commands",
      status: "started",
      summary: "Board command received.",
      payload: {
        duration_ms: durationMs(startedAt),
      },
    });
    const state = getSessionState(clientSessionId);
    const job = createWhiteboardJob(state, req.body?.command || req.body || {}, {
      recorder: defaultEventRecorder,
      session_id: clientSessionId,
      trace_id: traceId,
    });
    sessionStateStore.set(clientSessionId, state);
    const responseBody = {
      ok: true,
      job_id: job.job_id,
      status: job.status,
      spoken_ack: job.spoken_ack,
      board_state: getBoardSnapshot(state.board),
    };
    logRouteEvent({
      sessionId: clientSessionId,
      traceId,
      category: "board",
      action: "commands",
      status: "completed",
      summary: "Board command queued.",
      payload: {
        job_id: job.job_id,
        status: job.status,
        duration_ms: durationMs(startedAt),
      },
    });
    return res.status(202).json(responseBody);
  } catch (error) {
    const clientSessionId = req.body?.client_session_id || "default";
    logRouteEvent({
      sessionId: clientSessionId,
      traceId,
      category: "board",
      action: "commands",
      status: "failed",
      summary: "Board command failed.",
      payload: {
        error: error.message,
        duration_ms: durationMs(startedAt),
      },
    });
    return res.status(400).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/board/jobs", (req, res) => {
  const clientSessionId = req.query?.client_session_id || "default";
  const state = getSessionState(clientSessionId);
  const jobs = listWhiteboardJobs(state);
  logRouteEvent({
    sessionId: clientSessionId,
    traceId: makeTraceId("board"),
    category: "board",
    action: "jobs",
    status: "info",
    summary: "Board jobs listed.",
    payload: {
      jobs_count: jobs.length,
      board_version: state.board.version,
    },
  });
  return res.json({
    jobs,
    board_state: getBoardSnapshot(state.board),
  });
});

app.post("/board/operations", (req, res) => {
  const startedAt = nowMs();
  const traceId = makeTraceId("board");
  try {
    const clientSessionId = req.body?.client_session_id || "default";
    const operations = req.body?.operations;
    logRouteEvent({
      sessionId: clientSessionId,
      traceId,
      category: "board",
      action: "operations",
      status: "started",
      summary: "Board operations received.",
      payload: {
        operations,
        duration_ms: durationMs(startedAt),
      },
    });

    if (!Array.isArray(operations) || !operations.length) {
      logRouteEvent({
        sessionId: clientSessionId,
        traceId,
        category: "board",
        action: "operations",
        status: "failed",
        summary: "Board operations missing or empty.",
        payload: {
          operations,
          duration_ms: durationMs(startedAt),
        },
      });
      return res.status(400).json({
        ok: false,
        error: "operations must be a non-empty array.",
      });
    }

    const state = getSessionState(clientSessionId);
    if (req.body?.selected_item && typeof req.body.selected_item === "object") {
      state.selected_item = req.body.selected_item;
    }
    const result = applyBoardOperations(state.board, operations, { source: "user" });
    const moved = [...operations].reverse().find((operation) => operation.type === "move_item" && operation.id);
    if (moved) {
      state.recently_moved_item = {
        id: moved.id,
        type: "node",
        x: Number.isFinite(moved.x) ? moved.x : null,
        y: Number.isFinite(moved.y) ? moved.y : null,
      };
      state.selected_item = state.selected_item || { id: moved.id, type: "node" };
    }
    logRouteEvent({
      sessionId: clientSessionId,
      traceId,
      category: "board",
      action: "operations",
      status: "completed",
      summary: "Board operations applied.",
      payload: {
        source: "user",
        operations,
        result,
        recently_moved_item: state.recently_moved_item || null,
        duration_ms: durationMs(startedAt),
      },
    });
    return res.json(result);
  } catch (error) {
    const clientSessionId = req.body?.client_session_id || "default";
    logRouteEvent({
      sessionId: clientSessionId,
      traceId,
      category: "board",
      action: "operations",
      status: "failed",
      summary: "Board operations failed.",
      payload: {
        error: error.message,
        duration_ms: durationMs(startedAt),
      },
    });
    return res.status(400).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/board/undo", (req, res) => {
  const startedAt = nowMs();
  const traceId = makeTraceId("board");
  const clientSessionId = req.body?.client_session_id || "default";
  const state = getSessionState(clientSessionId);
  const undo = undoLastCheckpoint(state.board);
  logRouteEvent({
    sessionId: clientSessionId,
    traceId,
    category: "board",
    action: "undo",
    status: undo.ok ? "completed" : "failed",
    summary: undo.ok ? "Undo applied." : "Undo failed.",
    payload: {
      result: undo,
      duration_ms: durationMs(startedAt),
    },
  });
  return res.json(undo);
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`TeamsForAI realtime demo running on http://localhost:${PORT}`);
});
