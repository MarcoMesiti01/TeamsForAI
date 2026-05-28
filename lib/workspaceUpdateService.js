const { MODEL_ROLES, selectModel } = require("./modelPolicy");
const { buildCompactWorkspaceContext } = require("./workspaceContext");

const SUPPORTED_ACTIONS = new Set(["update", "clarify", "undo"]);
const UNDO_UTTERANCE_RE = /^undo\s+the\s+last\s+(conclusion|reasoning|memory|decision)\b/i;

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeUpdate(raw = {}) {
  const output = raw && typeof raw === "object" ? raw : {};
  const action = SUPPORTED_ACTIONS.has(output.action) ? output.action : "clarify";

  return {
    action,
    operations: Array.isArray(output.operations) ? output.operations : [],
    spoken_commit_notice: output.spoken_commit_notice == null ? "" : String(output.spoken_commit_notice),
    needs_clarification: output.needs_clarification == null ? "" : String(output.needs_clarification),
  };
}

function isExplicitUndoUtterance(utterance) {
  return UNDO_UTTERANCE_RE.test(utterance);
}

function buildFallbackUpdate(utterance) {
  return {
    action: "update",
    operations: [
      {
        type: "update_working_memory",
        summary: utterance,
        current_topic: utterance.slice(0, 80),
      },
    ],
    spoken_commit_notice: "",
    needs_clarification: "",
  };
}

function buildModelInput(payload, utterance, workspace) {
  return {
    turn_id: payload.turn_id,
    utterance,
    spoken_context: payload.spoken_context || "",
    workspace: buildCompactWorkspaceContext(workspace),
  };
}

function parseModelJson(data) {
  const raw = data?.output_text
    || data?.output?.flatMap((item) => item.content || []).find((content) => content.type === "output_text")?.text
    || "";
  return JSON.parse(raw || "{}");
}

function buildWorkspaceUpdateSchema() {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["update", "clarify", "undo"],
      },
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "update_working_memory",
                "add_entry",
                "correct_entry",
                "supersede_entry",
                "remove_entry",
              ],
            },
            id: { type: "string" },
            replacement_id: { type: "string" },
            category: {
              type: "string",
              enum: [
                "problem",
                "objectives",
                "constraints",
                "assumptions",
                "options",
                "criteria",
                "decisions",
                "open_questions",
              ],
            },
            content: { type: "string" },
            origin: {
              type: "string",
              enum: ["user_stated", "ai_inferred"],
            },
            source_turn_id: { type: "string" },
            summary: { type: "string" },
            current_topic: { type: "string" },
            candidate_options: { type: "array", items: { type: "string" } },
            provisional_observations: { type: "array", items: { type: "string" } },
            unresolved_references: { type: "array", items: { type: "string" } },
            board_focus: { type: ["string", "null"] },
          },
          additionalProperties: false,
        },
      },
      spoken_commit_notice: { type: "string" },
      needs_clarification: { type: "string" },
    },
    required: ["action", "operations", "spoken_commit_notice", "needs_clarification"],
    additionalProperties: false,
  };
}

async function callWorkspaceUpdateModel(modelInput, options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const model = options.model || selectModel({
    role: MODEL_ROLES.orchestrator,
    complexity: options.complexity || "medium",
    latency_budget: options.latency_budget || "medium",
    artifact_type: "workspace_update",
  }).model;
  const fetchImpl = options.fetchImpl || fetch;
  const systemPrompt = [
    "You propose reasoning workspace updates from a spoken user turn.",
    "Return only proposed operations; do not apply them.",
    "Use committed add/correct/supersede/remove operations only when the user clearly states durable reasoning content or a careful AI inference is warranted.",
    "Use update_working_memory for transient context.",
    "Preserve provenance with origin user_stated or ai_inferred on committed entries.",
    "Ask for clarification when the utterance is too ambiguous to safely update committed memory.",
    "Return strict JSON only.",
  ].join(" ");

  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(modelInput) },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "workspace_update",
          strict: true,
          schema: buildWorkspaceUpdateSchema(),
        },
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "Workspace update model request failed");
  }

  return normalizeUpdate(parseModelJson(data));
}

async function proposeWorkspaceUpdate(payload = {}, workspace, options = {}) {
  const utterance = normalizeText(payload.utterance || payload.user_goal);
  if (!utterance) {
    throw new Error("Workspace update utterance is required.");
  }

  if (isExplicitUndoUtterance(utterance)) {
    return {
      action: "undo",
      operations: [],
      spoken_commit_notice: "I will undo the last reasoning update.",
      needs_clarification: "",
    };
  }

  const modelInput = buildModelInput(payload, utterance, workspace);
  if (options.updateProvider) {
    return normalizeUpdate(await options.updateProvider(modelInput));
  }

  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return buildFallbackUpdate(utterance);
  }

  return callWorkspaceUpdateModel(modelInput, options);
}

module.exports = {
  proposeWorkspaceUpdate,
  normalizeUpdate,
};
