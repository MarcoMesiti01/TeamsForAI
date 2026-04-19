const path = require("path");
const express = require("express");
require("dotenv").config();
const { delegateToBrain } = require("./lib/brainService");

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
    name: "delegate_to_brain",
    description:
      "Delegate complex tasks to the backend Brain model for deeper reasoning, long-form output, and non-realtime workflows.",
    parameters: {
      type: "object",
      properties: {
        task_type: {
          type: "string",
          description: "Task class, e.g. draft_email, research, plan, summarize, analyze, code, workflow, flights",
        },
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
          description: "Desired output style: short_answer, full_text, json_plan, tool_instructions",
        },

        origin: {
          type: "string",
          description: "Optional route origin for flight tasks",
        },
        destination: {
          type: "string",
          description: "Optional route destination for flight tasks",
        },
        date: {
          type: "string",
          description: "Optional date (YYYY-MM-DD), especially for flight tasks",
        },
        max_results: {
          type: "number",
          description: "Optional max results for list-oriented tasks",
          default: 5,
        },
      },
      required: ["task_type", "user_goal"],
      additionalProperties: false,
    },
  },
];

const TOOLING_INSTRUCTIONS = [
  "You are the realtime controller assistant.",
  "Your job is low-latency voice UX: turn-taking, interruptions, and concise spoken replies.",
  "Answer directly only for simple conversational requests that need no deep reasoning.",
  "Call delegate_to_brain when tasks are multi-step, require long outputs, structured planning, external synthesis, or non-voice workflow actions.",
  "For flight price search requests, delegate_to_brain and include origin, destination, and date whenever available.",
  "When the brain returns, present a short spoken summary unless user requested full detail.",
].join(" ");

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

    if (toolName === "delegate_to_brain") {
      const state = sessionStateStore.get(clientSessionId) || {
        last_task_type: "general",
        last_user_goal: "",
      };
      const result = await delegateToBrain(toolArgs, state);
      sessionStateStore.set(clientSessionId, state);
      return res.json(result);
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

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`TeamsForAI realtime demo running on http://localhost:${PORT}`);
});
