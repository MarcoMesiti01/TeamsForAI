const { MODEL_ROLES, selectModel } = require("./modelPolicy");

const FALLBACK_RESPONSE = Object.freeze({
  spoken_summary: "I captured the current reasoning context, but deeper analysis requires an API connection.",
  full_response: "Workspace state was updated; grounded reasoning is unavailable without an API key.",
  reasoning_summary: "No model response was generated.",
  uncertainties: [],
  next_examination: "",
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return value == null ? "" : String(value);
}

function normalizeResponse(output = {}) {
  const raw = output && typeof output === "object" && !Array.isArray(output) ? output : {};

  return {
    spoken_summary: normalizeText(raw.spoken_summary),
    full_response: normalizeText(raw.full_response),
    reasoning_summary: normalizeText(raw.reasoning_summary),
    uncertainties: Array.isArray(raw.uncertainties)
      ? raw.uncertainties.map((item) => String(item))
      : [],
    next_examination: normalizeText(raw.next_examination),
  };
}

function buildWorkspaceReasoningSchema() {
  return {
    type: "object",
    properties: {
      spoken_summary: { type: "string" },
      full_response: { type: "string" },
      reasoning_summary: { type: "string" },
      uncertainties: {
        type: "array",
        items: { type: "string" },
      },
      next_examination: { type: "string" },
    },
    required: [
      "spoken_summary",
      "full_response",
      "reasoning_summary",
      "uncertainties",
      "next_examination",
    ],
    additionalProperties: false,
  };
}

function parseModelJson(data) {
  const raw = data?.output_text
    || data?.output?.flatMap((item) => item.content || []).find((content) => content.type === "output_text")?.text
    || "";
  return JSON.parse(raw || "{}");
}

function buildSystemPrompt() {
  return [
    "You generate substantive reasoning responses from a shared reasoning workspace.",
    "Ground claims in active committed workspace entries and identify the entries or categories that support the answer.",
    "Use working memory only as provisional context, not as settled fact.",
    "Distinguish uncertainties explicitly and do not hide missing evidence.",
    "Avoid inventing a decision, commitment, or user preference that is not present in active committed entries.",
    "Keep spoken_summary voice-ready, brief, and suitable for immediate speech.",
    "Return strict JSON only.",
  ].join(" ");
}

async function callWorkspaceReasoningModel(input, options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const model = options.model || selectModel({
    role: MODEL_ROLES.brain_reasoner,
    complexity: "high",
    latency_budget: "relaxed",
    artifact_type: "reasoning_workspace",
  }).model;
  const fetchImpl = options.fetchImpl || fetch;

  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: JSON.stringify(input) },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "workspace_reasoning_response",
          strict: true,
          schema: buildWorkspaceReasoningSchema(),
        },
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "Workspace reasoning request failed");
  }

  return normalizeResponse(parseModelJson(data));
}

async function generateWorkspaceResponse(input, options = {}) {
  const modelInput = clone(input || {});

  if (options.responseProvider) {
    return normalizeResponse(await options.responseProvider(modelInput));
  }

  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return normalizeResponse(FALLBACK_RESPONSE);
  }

  return callWorkspaceReasoningModel(modelInput, options);
}

module.exports = {
  generateWorkspaceResponse,
  normalizeResponse,
};
