const path = require("path");
const express = require("express");
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });
const { delegateToBrain } = require("./lib/brainService");
const { routeUserIntent } = require("./lib/intentRouter");
const { createBoardState, applyBoardOperations, getBoardSnapshot, undoLastCheckpoint } = require("./lib/boardState");
const { buildWhiteboardCommandFromIntent } = require("./lib/whiteboardCommandService");
const { createWhiteboardJob, listWhiteboardJobs } = require("./lib/whiteboardJobService");
const { MODEL_ROLES, selectModel } = require("./lib/modelPolicy");
const {
  createReasoningWorkspace,
  getWorkspaceSnapshot,
  undoLastWorkspaceCheckpoint,
} = require("./lib/reasoningWorkspace");
const {
  buildCompactWorkspaceContext,
  buildRealtimeWorkspaceBriefing,
} = require("./lib/workspaceContext");
const { coordinateReasoningTurn } = require("./lib/turnCoordinatorService");

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const sessionStateStore = new Map();
let reasoningCoordinatorOptions = {};
const REALTIME_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"]);

app.use(express.text({ type: ["application/sdp", "text/plain"] }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "coordinate_reasoning_turn",
    description:
      "Coordinate a substantive spoken reasoning turn through the shared workspace, including continuity, corrections, reasoning undo, committed memory, and board synchronization.",
    parameters: {
      type: "object",
      properties: {
        user_goal: {
          type: "string",
          description: "The user's substantive objective or utterance in plain language.",
        },
        utterance: {
          type: "string",
          description: "Verbatim or near-verbatim spoken user turn when available.",
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
        turn_id: {
          type: "string",
          description: "Optional stable id for this spoken turn.",
        },
      },
      required: [
        "spoken_context",
        "conversation_summary",
        "visible_board_context",
        "user_preference",
        "response_mode",
      ],
      anyOf: [
        { required: ["user_goal"] },
        { required: ["utterance"] },
      ],
      additionalProperties: false,
    },
  },
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
  "Call coordinate_reasoning_turn for substantive reasoning, continuity across turns, corrections to remembered reasoning, reasoning undo, comparisons, design or planning work, and any workspace-backed board work.",
  "Call coordinate_reasoning_turn when the user is externalizing thought, comparing options, designing, planning, mapping relationships, referring to prior reasoning, or updating committed memory.",
  "Call submit_whiteboard_command directly only when the user gives a narrow board edit that does not change reasoning memory, such as changing, connecting, moving, grouping, emphasizing, or deleting a board item.",
  "For board work, acknowledge quickly; the backend queues the visual update and the browser shows it when ready.",
  "Ask a brief clarification yourself when the artifact goal is ambiguous enough that delegation would not have a clear target.",
  "Do not decide board layout, whiteboard structure, or spatial placement yourself; pass substantive intent-level context to coordinate_reasoning_turn.",
  "Keep delegate_to_orchestrator and other legacy tools only for compatibility when coordinate_reasoning_turn is unavailable or inappropriate.",
  "Keep undo_board_operation as a direct deterministic UI action, and call it when the user asks to undo, go back, or revert the last board change.",
  "Use coordinate_reasoning_turn, not undo_board_operation, when the user asks to undo, correct, or revert reasoning, memory, a conclusion, or a decision.",
  "When the brain returns, present the spoken_summary briefly and do not narrate raw JSON.",
].join(" ");

function getSessionState(clientSessionId) {
  const existing = sessionStateStore.get(clientSessionId);
  if (existing) return existing;

  const state = {
    last_task_type: "general",
    last_user_goal: "",
    board: createBoardState(),
    workspace: createReasoningWorkspace(),
    whiteboard_jobs: [],
    selected_item: null,
    recently_moved_item: null,
  };
  sessionStateStore.set(clientSessionId, state);
  return state;
}

app.post("/session", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        error: "Missing OPENAI_API_KEY in environment.",
      });
    }

    const sdpOffer = typeof req.body === "string" ? req.body : "";
    const sdpPreview = sdpOffer.split(/\r?\n/, 1)[0] || "";
    if (!sdpOffer.trim()) {
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

    res.setHeader("Content-Type", "application/sdp");
    res.setHeader("X-Realtime-Model", selectedModel);
    res.setHeader("X-Realtime-Voice", selectedVoice);
    return res.send(responseText);
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected server error while creating realtime call.",
      details: error.message,
    });
  }
});

app.post("/tools/execute", async (req, res) => {
  try {
    const toolName = req.body?.name;
    const toolArgs = req.body?.arguments || {};
    const clientSessionId = req.body?.client_session_id || "default";

    if (!toolName) {
      return res.status(400).json({ ok: false, error: "Missing tool name." });
    }

    if (toolName === "coordinate_reasoning_turn") {
      const state = getSessionState(clientSessionId);
      if (toolArgs.selected_item && typeof toolArgs.selected_item === "object") {
        state.selected_item = toolArgs.selected_item;
      }
      const result = await coordinateReasoningTurn(toolArgs, state, reasoningCoordinatorOptions);
      let whiteboardJob = null;
      if (result.board_command) {
        const job = createWhiteboardJob(state, {
          ...result.board_command,
          expected_workspace_version: state.workspace.version,
        });
        whiteboardJob = {
          job_id: job.job_id,
          status: job.status,
          sync_status: job.sync_status,
          spoken_ack: job.spoken_ack,
        };
      }
      sessionStateStore.set(clientSessionId, state);
      return res.json({
        ...result,
        whiteboard_job: whiteboardJob,
        board_state: getBoardSnapshot(state.board),
        realtime_session_instructions: `${TOOLING_INSTRUCTIONS}\n\n${result.workspace_briefing || buildRealtimeWorkspaceBriefing(state.workspace)}`,
      });
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
          });
      if (toolName !== "delegate_to_brain" && intent.should_use_whiteboard === true) {
        const command = intent.board_command || buildWhiteboardCommandFromIntent(intent);
        const job = createWhiteboardJob(state, command);
        sessionStateStore.set(clientSessionId, state);
        return res.json({
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
        });
      }
      const result = await delegateToBrain(intent, state);
      sessionStateStore.set(clientSessionId, state);
      return res.json({
        ...result,
        intent,
        board_state: result.board_state || getBoardSnapshot(state.board),
      });
    }

    if (toolName === "submit_whiteboard_command") {
      const state = getSessionState(clientSessionId);
      const job = createWhiteboardJob(state, {
        ...toolArgs,
        user_goal: toolArgs.user_goal || toolArgs.change_description || "Update the whiteboard",
      });
      sessionStateStore.set(clientSessionId, state);
      return res.json({
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
      });
    }

    if (toolName === "undo_board_operation") {
      const state = getSessionState(clientSessionId);
      const undo = undoLastCheckpoint(state.board);
      return res.json({
        handled_by: "board",
        spoken_summary: undo.ok ? "I undid the last board change." : "There is nothing to undo yet.",
        full_response: undo.ok ? "Last checkpoint restored." : undo.error,
        reasoning_summary: "Undo restores the board snapshot from the previous checkpoint.",
        missing_info: [],
        board_operations: [{ type: "undo" }],
        undo_checkpoint_id: null,
        ...undo,
      });
    }

    return res.status(400).json({ ok: false, error: `Unknown tool: ${toolName}` });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Tool execution failed.",
      details: error.message,
    });
  }
});

app.get("/board/state", (req, res) => {
  const clientSessionId = req.query?.client_session_id || "default";
  const state = getSessionState(clientSessionId);
  return res.json(getBoardSnapshot(state.board));
});

app.get("/workspace/state", (req, res) => {
  const clientSessionId = req.query?.client_session_id || "default";
  const state = getSessionState(clientSessionId);
  return res.json(getWorkspaceSnapshot(state.workspace));
});

app.post("/workspace/undo", (req, res) => {
  const clientSessionId = req.body?.client_session_id || "default";
  const state = getSessionState(clientSessionId);
  const result = undoLastWorkspaceCheckpoint(state.workspace);
  const workspaceBriefing = buildRealtimeWorkspaceBriefing(state.workspace);
  let whiteboardJob = null;

  if (result.ok) {
    const job = createWhiteboardJob(state, {
      command_type: "reorganize_artifact",
      artifact_type: "idea_map",
      user_goal: "Synchronize the board after a reasoning correction.",
      change_description: "Reflect the current authoritative workspace after reasoning undo.",
      target_confidence: 1,
      workspace_context: buildCompactWorkspaceContext(state.workspace),
      sync_reason: "reasoning_undo",
      expected_workspace_version: state.workspace.version,
    });
    whiteboardJob = {
      job_id: job.job_id,
      status: job.status,
      sync_status: job.sync_status,
      spoken_ack: job.spoken_ack,
    };
  }

  return res.json({
    ...result,
    workspace_briefing: workspaceBriefing,
    realtime_session_instructions: `${TOOLING_INSTRUCTIONS}\n\n${workspaceBriefing}`,
    board_sync_required: result.ok,
    whiteboard_job: whiteboardJob,
  });
});

app.post("/board/commands", (req, res) => {
  try {
    const clientSessionId = req.body?.client_session_id || "default";
    const state = getSessionState(clientSessionId);
    const job = createWhiteboardJob(state, req.body?.command || req.body || {});
    sessionStateStore.set(clientSessionId, state);
    return res.status(202).json({
      ok: true,
      job_id: job.job_id,
      status: job.status,
      spoken_ack: job.spoken_ack,
      board_state: getBoardSnapshot(state.board),
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/board/jobs", (req, res) => {
  const clientSessionId = req.query?.client_session_id || "default";
  const state = getSessionState(clientSessionId);
  return res.json({
    jobs: listWhiteboardJobs(state),
    board_state: getBoardSnapshot(state.board),
  });
});

app.post("/board/operations", (req, res) => {
  try {
    const clientSessionId = req.body?.client_session_id || "default";
    const operations = req.body?.operations;

    if (!Array.isArray(operations) || !operations.length) {
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
    return res.json(result);
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/board/undo", (req, res) => {
  const clientSessionId = req.body?.client_session_id || "default";
  const state = getSessionState(clientSessionId);
  return res.json(undoLastCheckpoint(state.board));
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function setReasoningCoordinatorOptionsForTest(options = {}) {
  reasoningCoordinatorOptions = options;
}

function resetServerStateForTest() {
  sessionStateStore.clear();
  reasoningCoordinatorOptions = {};
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`TeamsForAI realtime demo running on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  getSessionState,
  resetServerStateForTest,
  setReasoningCoordinatorOptionsForTest,
  TOOL_DEFINITIONS,
  TOOLING_INSTRUCTIONS,
};
