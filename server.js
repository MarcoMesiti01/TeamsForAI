const path = require("path");
const express = require("express");
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });
const { delegateToBrain } = require("./lib/brainService");
const { routeUserIntent } = require("./lib/intentRouter");
const { createBoardState, applyBoardOperations, getBoardSnapshot, undoLastCheckpoint } = require("./lib/boardState");

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_REALTIME_MODEL || "gpt-4o-realtime-preview";
const sessionStateStore = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "route_user_intent",
    description:
      "Route spoken thinking or design work into structured intent, then let the backend Brain produce typed board operations.",
    parameters: {
      type: "object",
      properties: {
        user_goal: {
          type: "string",
          description: "User objective in plain language",
        },
        collected_context: {
          type: "string",
          description: "Compact context already collected from conversation",
        },
        missing_info: {
          type: "array",
          description: "List of still-missing fields if any",
          items: {
            type: "string",
          },
        },
        response_mode: {
          type: "string",
          description: "Desired output style: short_answer, board_update, full_text, json_plan, tool_instructions",
        },
      },
      required: ["user_goal"],
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
  "Keep casual chat, greetings, and simple factual answers conversational without using the board.",
  "Use the board earlier for thinking work: call route_user_intent when the user wants to think through, organize, compare, prioritize, design, plan, map, brainstorm, structure, or explore an idea, even if the request is not very complex yet.",
  "Also call route_user_intent for product thinking, workflows, user journeys, diagrams, whiteboards, idea maps, or non-voice workflow actions.",
  "Call undo_board_operation when the user asks to undo, go back, or revert the last board change.",
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

    const requestedModel = (req.body?.model || DEFAULT_MODEL).toString().trim();
    if (!requestedModel) {
      return res.status(400).json({ error: "Model is required." });
    }

    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: requestedModel,
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
      model: requestedModel,
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

    if (toolName === "route_user_intent" || toolName === "delegate_to_brain") {
      const state = getSessionState(clientSessionId);
      const intent = toolName === "route_user_intent" ? routeUserIntent(toolArgs) : toolArgs;
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
