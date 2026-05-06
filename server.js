const path = require("path");
const express = require("express");
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });
const { delegateToBrain } = require("./lib/brainService");
const { routeUserIntent } = require("./lib/intentRouter");
const { createBoardState, applyBoardOperations, getBoardSnapshot, undoLastCheckpoint } = require("./lib/boardState");
const { MODEL_ROLES, selectModel } = require("./lib/modelPolicy");

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const sessionStateStore = new Map();

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

    const frontendModelOverride = String(req.body?.model || "").trim();
    const selectedModel = frontendModelOverride || selectModel({
      role: MODEL_ROLES.realtime_controller,
      complexity: "low",
      latency_budget: "realtime",
      artifact_type: "conversation",
    }).model;

    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: selectedModel,
        voice: "alloy",
        tools: TOOL_DEFINITIONS,
        instructions: TOOLING_INSTRUCTIONS,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || "Failed to create realtime session.",
        details: data,
      });
    }

    return res.json({
      client_secret: data.client_secret,
      model: selectedModel,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected server error while creating realtime session.",
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

    if (toolName === "delegate_to_orchestrator" || toolName === "route_user_intent" || toolName === "delegate_to_brain") {
      const state = getSessionState(clientSessionId);
      const intent = toolName === "delegate_to_brain" ? toolArgs : await routeUserIntent(toolArgs, { board: state.board });
      const result = await delegateToBrain(intent, state);
      sessionStateStore.set(clientSessionId, state);
      return res.json({
        ...result,
        intent,
        board_state: result.board_state || getBoardSnapshot(state.board),
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
    const result = applyBoardOperations(state.board, operations, { source: "user" });
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

app.listen(PORT, () => {
  console.log(`TeamsForAI realtime demo running on http://localhost:${PORT}`);
});
