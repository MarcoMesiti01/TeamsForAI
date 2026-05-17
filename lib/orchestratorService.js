const { getBoardSnapshot } = require("./boardState");
const { buildCompactBoardContext } = require("./boardContext");
const { buildWhiteboardCommandFromIntent } = require("./whiteboardCommandService");
const { MODEL_ROLES, selectModel } = require("./modelPolicy");

const INTENT_TYPES = new Set(["answer_simple", "develop_idea_map", "clarify", "call_tool", "undo"]);
const ARTIFACT_TYPES = new Set([
  "conversation",
  "idea_map",
  "process_flow",
  "architecture_map",
  "comparison_map",
  "action_plan",
  "board",
  "external_tool",
  "none",
]);
const ROUTE_ACTIONS = new Set(["answer_conversationally", "use_whiteboard", "ask_clarification", "call_tool", "undo"]);
const BOARD_STRATEGIES = new Set([
  "extend_existing",
  "create_new_group",
  "refine_existing",
  "reorganize_existing",
  "no_board",
]);

function normalizeText(value) {
  return String(value || "").trim();
}

function getApiKey() {
  return process.env.OPENAI_API_KEY || "";
}

function compactConversationContext(payload = {}, limit = 6) {
  const contextParts = [
    ["conversation_summary", payload.conversation_summary],
    ["spoken_context", payload.spoken_context],
    ["user_preference", payload.user_preference],
    ["collected_context", payload.collected_context || payload.known_context || payload.context_summary],
  ]
    .map(([label, value]) => {
      const text = normalizeText(value);
      return text ? `${label}: ${text}` : "";
    })
    .filter(Boolean);

  if (contextParts.length) return contextParts.join("\n");

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
    artifacts: ["conversation", "idea_map", "process_flow", "architecture_map", "comparison_map", "action_plan"],
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
  const board = options.board || payload.board || payload.board_snapshot;
  const boardContext = options.board_context || payload.board_context || buildCompactBoardContext(board, {
    selected_item: options.selected_item || payload.selected_item,
    recently_moved_item: options.recently_moved_item || payload.recently_moved_item,
  });

  return {
    current_user_turn: userGoal,
    compact_conversation_context: compactConversationContext(payload),
    current_board_snapshot: compactBoardSnapshot(board),
    current_board_context: boardContext,
    available_capabilities: options.capabilities || payload.capabilities || getDefaultCapabilities(),
    missing_info: Array.isArray(payload.missing_info) ? payload.missing_info : [],
    response_mode: normalizeText(payload.response_mode),
    visible_board_context: normalizeText(payload.visible_board_context),
    candidate_artifact_type: normalizeText(payload.candidate_artifact_type),
  };
}

function fallbackDecision(input, reason) {
  const goal = normalizeText(input?.current_user_turn || input?.user_goal || "");
  const lower = goal.toLowerCase();
  const visibleContext = normalizeText(input?.visible_board_context);
  const boardHasContent = Boolean(input?.current_board_snapshot?.nodes?.length);
  const boardStrategy = inferBoardStrategy(lower, visibleContext, boardHasContent);

  if (/^(undo|revert|go back)\b|\b(undo that|undo last|revert that|go back)\b/.test(lower)) {
    return {
      intent_type: "undo",
      artifact_type: "board",
      target_artifact: "board",
      should_use_whiteboard: false,
      route_action: "undo",
      board_strategy: "no_board",
      visual_summary_goal: "",
      reason: reason || "Deterministic fallback recognized an explicit undo command.",
      confidence: 0.95,
      required_context: [],
      preferred_model: "deterministic-fallback",
      tool_plan: [{ tool: "undo_board_operation", args: {}, reason: "User asked to undo the latest board change." }],
    };
  }

  const artifactType = inferArtifactType(goal);
  if (artifactType !== "conversation") {
    const boardIntent = {
      intent_type: "develop_idea_map",
      artifact_type: artifactType,
      target_artifact: artifactType,
      should_use_whiteboard: true,
      board_strategy: boardStrategy,
      visual_summary_goal: `Create a concise visual summary for: ${goal}`,
      user_goal: goal,
      confidence: 0.72,
    };
    return {
      ...boardIntent,
      route_action: "use_whiteboard",
      reason: reason || "Deterministic board-first fallback recognized a thinking task that benefits from a visual artifact.",
      required_context: [],
      preferred_model: selectModel({ role: MODEL_ROLES.orchestrator }).model,
      tool_plan: [
        {
          tool: "submit_whiteboard_command",
          args: { artifact_type: artifactType, board_strategy: boardStrategy },
          reason: "Queue asynchronous whiteboard planning for the user's thinking task.",
        },
      ],
      board_command: buildWhiteboardCommandFromIntent(boardIntent),
    };
  }

  return {
    intent_type: "answer_simple",
    artifact_type: "conversation",
    target_artifact: "conversation",
    should_use_whiteboard: false,
    route_action: "answer_conversationally",
    board_strategy: "no_board",
    visual_summary_goal: "",
    reason: reason || "Deterministic fallback used because orchestrator routing was unavailable.",
    confidence: 0.35,
    required_context: [],
    preferred_model: selectModel({ role: MODEL_ROLES.orchestrator }).model,
    tool_plan: [],
    board_command: null,
  };
}

function inferArtifactType(goal) {
  const text = normalizeText(goal).toLowerCase();
  if (!text) return "conversation";
  if (/(^|\b)(hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|how are you)\b/.test(text) && text.length < 80) {
    return "conversation";
  }
  if (/(don't|do not|without|no)\s+(use\s+)?(board|whiteboard|diagram|map|visual)/i.test(goal)) {
    return "conversation";
  }
  if (/(process|workflow|flow|steps|funnel|pipeline|journey|onboarding|approval|approvazione|processo|flusso|passaggi|quy tr[ìi]nh|lu[oồ]ng|手順|工程|プロセス)/i.test(goal)) {
    return "process_flow";
  }
  if (/(architecture|system design|technical design|components|services|stack|infrastructure|architettura|sistema|componenti|kiến trúc|システム|設計)/i.test(goal)) {
    return "architecture_map";
  }
  if (/(compare|comparison|versus| vs |trade-?off|options|alternatives|confronta|compar(a|e)|opzioni|so sánh|比較)/i.test(goal)) {
    return "comparison_map";
  }
  if (/(action plan|roadmap|plan|milestone|next steps|tasks|priorities|piano|azioni|prossimi passi|kế hoạch|計画|次のステップ)/i.test(goal)) {
    return "action_plan";
  }
  if (/(map|organize|structure|brainstorm|design|strategy|idea|think through|plan|describe|explain|progetta|organizza|struttura|descrivi|spiega|thiết kế|mô tả|説明|整理)/i.test(goal)) {
    return "idea_map";
  }
  return "conversation";
}

function inferBoardStrategy(lowerGoal, visibleContext, boardHasContent) {
  if (!boardHasContent) return "create_new_group";
  if (/\b(refine|improve|update|adjust|add|expand|continue|this|that|existing|current)\b|raffina|migliora|aggiungi|continua|questo|esistente|hiện tại|追加|改善|これ/.test(lowerGoal) || visibleContext) {
    return "refine_existing";
  }
  if (/\b(reorganize|restructure|clean up|layout)\b|riorganizza|ristruttura|整理/.test(lowerGoal)) {
    return "reorganize_existing";
  }
  return "create_new_group";
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
  const boardStrategy = BOARD_STRATEGIES.has(decision.board_strategy)
    ? decision.board_strategy
    : decision.should_use_whiteboard ? "create_new_group" : "no_board";
  return {
    intent_type: intentType,
    user_goal: input.current_user_turn,
    artifact_type: artifactType,
    target_artifact: artifactType === "conversation" ? "conversation" : artifactType,
    should_use_whiteboard: decision.should_use_whiteboard,
    route_action: inferRouteAction(decision),
    board_strategy: boardStrategy,
    visual_summary_goal: normalizeText(decision.visual_summary_goal),
    reason: normalizeText(decision.reason),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    required_context: coerceArray(decision.required_context),
    missing_info: coerceArray(decision.required_context),
    preferred_model: normalizeText(decision.preferred_model) || selectModel({ role: MODEL_ROLES.orchestrator }).model,
    tool_plan: normalizeToolPlan(decision.tool_plan),
    board_command: decision.should_use_whiteboard
      ? buildWhiteboardCommandFromIntent({
          ...decision,
          user_goal: input.current_user_turn,
          target_artifact: artifactType,
        })
      : null,
    known_context: input.compact_conversation_context,
    visible_board_context: input.visible_board_context,
    candidate_artifact_type: input.candidate_artifact_type,
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
    "Use the whiteboard by default for non-casual thinking work: planning, process explanation, architecture design, comparisons, decisions, workflows, action plans, and idea development.",
    "Keep casual chat, tiny factual answers, explicit no-board requests, and unsafe destructive changes off the board.",
    "Choose the visual artifact type that best summarizes the turn: idea_map, process_flow, architecture_map, comparison_map, or action_plan.",
    "Choose board_strategy: extend_existing or refine_existing for related follow-ups, create_new_group for new topics, reorganize_existing only when the user asks to restructure.",
    "Ask for brief clarification when the intended artifact or goal is ambiguous.",
    "Do not decide board layout details here; only choose the route and target artifact at the intent level.",
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
              board_strategy: { type: "string", enum: Array.from(BOARD_STRATEGIES) },
              visual_summary_goal: { type: "string" },
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
              board_command: {
                type: "object",
                additionalProperties: true,
              },
            },
            required: ["intent_type", "artifact_type", "should_use_whiteboard", "route_action", "board_strategy", "visual_summary_goal", "reason", "confidence", "required_context", "preferred_model", "tool_plan"],
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
