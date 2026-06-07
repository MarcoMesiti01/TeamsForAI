const { MODEL_ROLES, selectModel } = require("./modelPolicy");
const { applyWorkspaceOperations } = require("./reasoningWorkspace");
const { buildCompactWorkspaceContext } = require("./workspaceContext");

const SUPPORTED_ACTIONS = new Set(["update", "clarify", "undo"]);
const CATEGORIES = new Set([
  "problem",
  "objectives",
  "constraints",
  "assumptions",
  "options",
  "criteria",
  "decisions",
  "open_questions",
]);
const ORIGINS = new Set(["user_stated", "ai_inferred"]);
const OPERATION_TYPES = new Set([
  "update_working_memory",
  "add_entry",
  "correct_entry",
  "supersede_entry",
  "remove_entry",
]);
const COMMITTED_OPERATION_TYPES = new Set([
  "add_entry",
  "correct_entry",
  "supersede_entry",
  "remove_entry",
]);
const WORKING_MEMORY_TEXT_FIELDS = new Set(["summary", "current_topic"]);
const WORKING_MEMORY_ARRAY_FIELDS = new Set([
  "candidate_options",
  "provisional_observations",
  "unresolved_references",
]);
const WORKING_MEMORY_FIELDS = new Set([
  ...WORKING_MEMORY_TEXT_FIELDS,
  ...WORKING_MEMORY_ARRAY_FIELDS,
  "board_focus",
]);
const ENTRY_OPERATION_FIELDS = new Set([
  "type",
  "id",
  "category",
  "content",
  "origin",
  "source_turn_id",
]);
const REPLACEMENT_OPERATION_FIELDS = new Set([
  ...ENTRY_OPERATION_FIELDS,
  "replacement_id",
]);
const UNDO_NEGATION_RE = /\b(?:do\s+not|don't|dont|not|never)\b(?:\W+\w+){0,5}\W+undo\b/i;
const UNDO_POST_NEGATION_RE = /\b(?:is|was|would\s+be)\s+not\b|\bnot\s+what\s+i\s+want\b/i;
const UNDO_CONDITIONAL_RE = /\b(?:if|unless|assuming|provided\s+that)\b/i;
const UNDO_REQUEST_RE = /^\s*(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:undo|revert|roll\s+back)\s+(?:the\s+)?(?:last|previous|recent|that\s+last)\s+(?:reasoning(?:\s+update)?|memory(?:\s+update)?|decision|conclusion)\b/i;

function normalizeText(value) {
  return String(value || "").trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOnlyFields(operation, allowedFields) {
  return Object.keys(operation).every((field) => allowedFields.has(field));
}

function normalizeWorkingMemoryOperation(operation) {
  const normalized = { type: "update_working_memory" };
  let recognizedChangeCount = 0;

  if (!hasOnlyFields(operation, new Set(["type", ...WORKING_MEMORY_FIELDS]))) {
    return null;
  }

  for (const field of WORKING_MEMORY_TEXT_FIELDS) {
    if (field in operation) {
      if (typeof operation[field] !== "string") return null;
      normalized[field] = operation[field];
      recognizedChangeCount += 1;
    }
  }

  for (const field of WORKING_MEMORY_ARRAY_FIELDS) {
    if (field in operation) {
      if (!Array.isArray(operation[field])) return null;
      if (operation[field].some((item) => !isNonEmptyString(item))) return null;
      normalized[field] = clone(operation[field]);
      recognizedChangeCount += 1;
    }
  }

  if ("board_focus" in operation) {
    if (operation.board_focus !== null && typeof operation.board_focus !== "string") return null;
    normalized.board_focus = operation.board_focus;
    recognizedChangeCount += 1;
  }

  return recognizedChangeCount > 0 ? normalized : null;
}

function normalizeCommittedOperation(operation) {
  const allowedFields = operation.type === "correct_entry" || operation.type === "supersede_entry"
    ? REPLACEMENT_OPERATION_FIELDS
    : ENTRY_OPERATION_FIELDS;

  if (!hasOnlyFields(operation, allowedFields)) return null;
  if (!isNonEmptyString(operation.id)) return null;
  if (!CATEGORIES.has(operation.category)) return null;
  if (!isNonEmptyString(operation.content)) return null;
  if (!ORIGINS.has(operation.origin)) return null;
  if (!isNonEmptyString(operation.source_turn_id)) return null;

  const normalized = {
    type: operation.type,
    id: operation.id,
    category: operation.category,
    content: operation.content,
    origin: operation.origin,
    source_turn_id: operation.source_turn_id,
  };

  if (operation.type === "correct_entry" || operation.type === "supersede_entry") {
    if (!isNonEmptyString(operation.replacement_id)) return null;
    normalized.replacement_id = operation.replacement_id;
  }

  return normalized;
}

function normalizeWorkspaceOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    return null;
  }
  if (!OPERATION_TYPES.has(operation.type)) {
    return null;
  }
  if (operation.type === "update_working_memory") {
    return normalizeWorkingMemoryOperation(operation);
  }
  if (COMMITTED_OPERATION_TYPES.has(operation.type)) {
    return normalizeCommittedOperation(operation);
  }
  return null;
}

function normalizeOperations(operations) {
  if (!Array.isArray(operations)) {
    return [];
  }

  const normalized = operations.map(normalizeWorkspaceOperation);
  return normalized.every(Boolean) ? normalized : null;
}

function operationsAreWorkspaceValid(operations, workspace) {
  if (!workspace || operations.length === 0) {
    return true;
  }

  try {
    applyWorkspaceOperations(clone(workspace), operations, { source: "proposal_validation" });
    return true;
  } catch {
    return false;
  }
}

function normalizeUpdate(raw = {}, workspace) {
  const output = raw && typeof raw === "object" ? raw : {};
  const action = SUPPORTED_ACTIONS.has(output.action) ? output.action : "clarify";
  const operations = normalizeOperations(output.operations);
  const malformedUpdateOperations = action === "update"
    && (!Array.isArray(output.operations) || operations?.length === 0);
  const validOperations = operations !== null
    && !malformedUpdateOperations
    && operationsAreWorkspaceValid(operations, workspace);
  const normalizedAction = validOperations ? action : "clarify";
  const normalizedOperations = normalizedAction === "update" ? operations : [];
  const failedUpdateProposal = action === "update" && normalizedAction !== "update";

  return {
    action: normalizedAction,
    operations: normalizedOperations,
    spoken_commit_notice: failedUpdateProposal
      ? ""
      : output.spoken_commit_notice == null ? "" : String(output.spoken_commit_notice),
    needs_clarification: output.needs_clarification == null ? "" : String(output.needs_clarification),
  };
}

function isExplicitUndoUtterance(utterance) {
  return UNDO_REQUEST_RE.test(utterance)
    && !UNDO_NEGATION_RE.test(utterance)
    && !UNDO_POST_NEGATION_RE.test(utterance)
    && !UNDO_CONDITIONAL_RE.test(utterance);
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
  const workingMemorySchema = (field, fieldSchema) => ({
    type: "object",
    properties: {
      type: { type: "string", enum: ["update_working_memory"] },
      [field]: fieldSchema,
    },
    required: ["type", field],
    additionalProperties: false,
  });
  const entrySchema = (operationType) => ({
    type: "object",
    properties: {
      type: { type: "string", enum: [operationType] },
      id: { type: "string" },
      category: {
        type: "string",
        enum: [...CATEGORIES],
      },
      content: { type: "string" },
      origin: {
        type: "string",
        enum: [...ORIGINS],
      },
      source_turn_id: { type: "string" },
    },
    required: ["type", "id", "category", "content", "origin", "source_turn_id"],
    additionalProperties: false,
  });
  const replacementSchema = (operationType) => ({
    type: "object",
    properties: {
      type: { type: "string", enum: [operationType] },
      id: { type: "string" },
      replacement_id: { type: "string" },
      category: {
        type: "string",
        enum: [...CATEGORIES],
      },
      content: { type: "string" },
      origin: {
        type: "string",
        enum: [...ORIGINS],
      },
      source_turn_id: { type: "string" },
    },
    required: ["type", "id", "replacement_id", "category", "content", "origin", "source_turn_id"],
    additionalProperties: false,
  });

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
          anyOf: [
            workingMemorySchema("summary", { type: "string" }),
            workingMemorySchema("current_topic", { type: "string" }),
            workingMemorySchema("candidate_options", { type: "array", items: { type: "string" } }),
            workingMemorySchema("provisional_observations", { type: "array", items: { type: "string" } }),
            workingMemorySchema("unresolved_references", { type: "array", items: { type: "string" } }),
            workingMemorySchema("board_focus", { type: ["string", "null"] }),
            entrySchema("add_entry"),
            replacementSchema("correct_entry"),
            replacementSchema("supersede_entry"),
            entrySchema("remove_entry"),
          ],
        },
      },
      spoken_commit_notice: { type: "string" },
      needs_clarification: { type: "string" },
    },
    required: ["action", "operations", "spoken_commit_notice", "needs_clarification"],
    additionalProperties: false,
  };
}

async function callWorkspaceUpdateModel(modelInput, options = {}, workspace) {
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

  return normalizeUpdate(parseModelJson(data), workspace);
}

async function proposeWorkspaceUpdate(payload = {}, workspace, options = {}) {
  const utterance = [payload.utterance, payload.user_goal, payload.spoken_context]
    .map(normalizeText)
    .find(Boolean) || "";
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
    return normalizeUpdate(await options.updateProvider(modelInput), workspace);
  }

  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return buildFallbackUpdate(utterance);
  }

  return callWorkspaceUpdateModel(modelInput, options, workspace);
}

module.exports = {
  proposeWorkspaceUpdate,
  normalizeUpdate,
};
