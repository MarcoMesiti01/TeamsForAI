const { getBoardSnapshot } = require("./boardState");
const { MODEL_ROLES, selectModel } = require("./modelPolicy");

const INTENT_TYPES = new Set(["answer_simple", "develop_idea_map", "clarify", "call_tool", "undo"]);
const ARTIFACT_TYPES = new Set(["conversation", "idea_map", "board", "external_tool", "none"]);
const ROUTE_ACTIONS = new Set(["answer_conversationally", "use_whiteboard", "ask_clarification", "call_tool", "undo"]);

function normalizeText(value) {
  return String(value || "").trim();
}

function getApiKey() {
  return process.env.OPENAI_API_KEY || "";
}

function compactConversationContext(payload = {}, limit = 6) {
  const explicit = normalizeText(payload.collected_context || payload.known_context || payload.context_summary);
  if (explicit) return explicit;

  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.conversation)
      ? payload.conversation
      : [];

  return messages
    .slice(-limit)
    .map((message) => {
      const role = normalizeText(message.role || message.speaker || "unknown");
      const content = normalizeText(message.content || message.text || message.transcript);
      return content ? `${role}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function compactBoardSnapshot(board) {
  if (!board) {
    return { version: 0, nodes: [], edges: [], groups: [], can_undo: false };
  }

  const snapshot = board.nodes && board.edges && board.groups && Array.isArray(board.operation_log)
    ? getBoardSnapshot(board)
    : board;

  return {
    version: Number.isFinite(snapshot.version) ? snapshot.version : 0,
    nodes: (snapshot.nodes || []).slice(-30).map((node) => ({
      id: node.id,
      text: node.text,
      group_id: node.group_id || null,
      emphasis: node.emphasis || "normal",
    })),
    edges: (snapshot.edges || []).slice(-40).map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: edge.label || "",
    })),
    groups: (snapshot.groups || []).slice(-15).map((group) => ({
      id: group.id,
      title: group.title,
      node_ids: Array.isArray(group.node_ids) ? group.node_ids.slice(0, 30) : [],
    })),
    can_undo: Boolean(snapshot.can_undo),
  };
}

function getDefaultCapabilities() {
  return {
    artifacts: ["conversation", "idea_map"],
    board_operations: [
      "create_node",
      "update_node",
      "create_edge",
      "create_group",
      "move_item",
      "emphasize_item",
      "delete_item",
      "undo",
    ],
    tools: [
      {
        name: "delegate_to_brain",
        description: "Generate a conversational response or typed whiteboard operations after routing.",
      },
      {
        name: "undo_board_operation",
        description: "Undo the latest whiteboard checkpoint.",
      },
      {
        name: "search_flights",
        description: "Search the mock flight dataset when origin, destination, and date are known.",
        required_context: ["origin", "destination", "date"],
      },
    ],
  };
}

function buildOrchestratorInput(payload = {}, options = {}) {
  const userGoal = normalizeText(payload.user_goal || payload.userGoal || payload.goal || payload.current_user_turn);
  if (!userGoal) {
    throw new Error("user_goal is required");
  }

  return {
    current_user_turn: userGoal,
    compact_conversation_context: compactConversationContext(payload),
    current_board_snapshot: compactBoardSnapshot(options.board || payload.board || payload.board_snapshot),
    available_capabilities: options.capabilities || payload.capabilities || getDefaultCapabilities(),
    missing_info: Array.isArray(payload.missing_info) ? payload.missing_info : [],
    response_mode: normalizeText(payload.response_mode),
  };
}

function fallbackDecision(input, reason) {
  const goal = normalizeText(input?.current_user_turn || input?.user_goal || "");
  const lower = goal.toLowerCase();

  if (/^(undo|revert|go back)\b|\b(undo that|undo last|revert that|go back)\b/.test(lower)) {
    return {
      intent_type: "undo",
      artifact_type: "board",
      target_artifact: "board",
      should_use_whiteboard: false,
      route_action: "undo",
      reason: reason || "Deterministic fallback recognized an explicit undo command.",
      confidence: 0.95,
      required_context: [],
      preferred_model: "deterministic-fallback",
      tool_plan: [{ tool: "undo_board_operation", args: {}, reason: "User asked to undo the latest board change." }],
    };
  }

  return {
    intent_type: "answer_simple",
    artifact_type: "conversation",
    target_artifact: "conversation",
    should_use_whiteboard: false,
    route_action: "answer_conversationally",
    reason: reason || "Deterministic fallback used because orchestrator routing was unavailable.",
    confidence: 0.35,
    required_context: [],
    preferred_model: selectModel({ role: MODEL_ROLES.orchestrator }).model,
    tool_plan: [],
  };
}

function coerceArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function normalizeToolPlan(value) {
  if (!Array.isArray(value)) return [];
  return value.map((step) => ({
    tool: normalizeText(step.tool || step.name || step.action),
    args: step.args && typeof step.args === "object" ? step.args : {},
    reason: normalizeText(step.reason),
  })).filter((step) => step.tool);
}

function inferRouteAction(decision) {
  if (decision.route_action && ROUTE_ACTIONS.has(decision.route_action)) return decision.route_action;
  if (decision.intent_type === "undo") return "undo";
  if (decision.intent_type === "clarify") return "ask_clarification";
  if (decision.intent_type === "call_tool") return "call_tool";
  if (decision.should_use_whiteboard) return "use_whiteboard";
  return "answer_conversationally";
}

function normalizeDecision(rawDecision, input) {
  const decision = rawDecision && typeof rawDecision === "object" ? rawDecision : {};
  const intentType = INTENT_TYPES.has(decision.intent_type) ? decision.intent_type : null;
  const artifactType = ARTIFACT_TYPES.has(decision.artifact_type) ? decision.artifact_type : null;

  if (!intentType || !artifactType || typeof decision.should_use_whiteboard !== "boolean") {
    throw new Error("Orchestrator decision is missing required structured fields.");
  }

  const confidence = Number(decision.confidence);
  return {
    intent_type: intentType,
    user_goal: input.current_user_turn,
    artifact_type: artifactType,
    target_artifact: artifactType === "conversation" ? "conversation" : artifactType,
    should_use_whiteboard: decision.should_use_whiteboard,
    route_action: inferRouteAction(decision),
    reason: normalizeText(decision.reason),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    required_context: coerceArray(decision.required_context),
    missing_info: coerceArray(decision.required_context),
    preferred_model: normalizeText(decision.preferred_model) || selectModel({ role: MODEL_ROLES.orchestrator }).model,
    tool_plan: normalizeToolPlan(decision.tool_plan),
    known_context: input.compact_conversation_context,
  };
}

function parseModelJson(data) {
  const raw = data?.output_text
    || data?.output?.flatMap((item) => item.content || []).find((content) => content.type === "output_text")?.text
    || "";
  return JSON.parse(raw || "{}");
}

async function callOrchestratorModel(input, options = {}) {
  const apiKey = options.apiKey ?? getApiKey();
  if (!apiKey) {
    return fallbackDecision(input, "Missing OPENAI_API_KEY; using deterministic fallback router.");
  }

  const modelSelection = selectModel({
    role: MODEL_ROLES.orchestrator,
    complexity: input.current_board_snapshot?.nodes?.length || input.compact_conversation_context ? "medium" : "low",
    latency_budget: "low",
    artifact_type: input.response_mode || "conversation",
  });
  const model = options.model || modelSelection.model;
  const fetchImpl = options.fetchImpl || fetch;
  const systemPrompt = [
    "You are a backend orchestration router for a voice-first AI whiteboard.",
    "Decide whether the backend should answer conversationally, use the whiteboard, ask a clarification, undo, or call another tool.",
    "Do not rely on keyword spotting; infer the user's task, artifact needs, available board context, and required missing context.",
    "Prefer the whiteboard for spatial, multi-part, comparative, planning, design, workflow, map, or idea-development work.",
    "Keep simple greetings and one-off conversational answers off the board.",
    "Return strict JSON matching the provided schema only.",
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
        { role: "user", content: JSON.stringify(input) },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "orchestrator_decision",
          schema: {
            type: "object",
            properties: {
              intent_type: { type: "string", enum: Array.from(INTENT_TYPES) },
              artifact_type: { type: "string", enum: Array.from(ARTIFACT_TYPES) },
              should_use_whiteboard: { type: "boolean" },
              route_action: { type: "string", enum: Array.from(ROUTE_ACTIONS) },
              reason: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              required_context: { type: "array", items: { type: "string" } },
              preferred_model: { type: "string" },
              tool_plan: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    tool: { type: "string" },
                    args: { type: "object", additionalProperties: true },
                    reason: { type: "string" },
                  },
                  required: ["tool", "args", "reason"],
                  additionalProperties: false,
                },
              },
            },
            required: ["intent_type", "artifact_type", "should_use_whiteboard", "route_action", "reason", "confidence", "required_context", "preferred_model", "tool_plan"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "Orchestrator model request failed");
  }

  return normalizeDecision(parseModelJson(data), input);
}

async function createOrchestratorDecision(payload = {}, options = {}) {
  const input = buildOrchestratorInput(payload, options);

  if (options.decisionProvider) {
    return normalizeDecision(await options.decisionProvider(input), input);
  }

  const obviousFallback = fallbackDecision(input, "");
  if (obviousFallback.intent_type === "undo") return obviousFallback;

  try {
    return await callOrchestratorModel(input, options);
  } catch (error) {
    return fallbackDecision(input, `Orchestrator unavailable or returned invalid JSON: ${error.message}`);
  }
}

module.exports = {
  createOrchestratorDecision,
  buildOrchestratorInput,
  getDefaultCapabilities,
  normalizeDecision,
  fallbackDecision,
};
