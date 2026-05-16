const { MODEL_ROLES, selectModel } = require("./modelPolicy");
const { buildCompactBoardContext } = require("./boardContext");
const { getBoardSnapshot, getSupportedOperationTypes } = require("./boardState");
const { validateBoardOperations } = require("./boardOperationValidator");

const DEFAULT_LAYOUT_CONSTRAINTS = Object.freeze({
  canvas_width: 1200,
  canvas_height: 900,
  node_width: 210,
  node_height: 112,
  min_node_spacing: 180,
  group_padding: 28,
  edge_readability: "prefer short curved edges with clear labels and avoid crossing existing links when possible",
});

function slugId(prefix, text, index) {
  const slug = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 28) || "item";
  return `${prefix}-${index + 1}-${slug}`;
}

function detectLanguage(text) {
  if (/[ぁ-んァ-ン一-龯]/.test(text)) return "ja";
  if (/(mô tả|quy trình|các bước|luồng|sơ đồ|ý tưởng|chiến lược|thiết kế|tổ chức|phê duyệt|hoàn tiền)/i.test(text)) return "vi";
  if (/(descrivi|processo|passaggi|flusso|organizza|struttura|progetta|mappa|idee|strategia|approvazione|rimbor)/i.test(text)) return "it";
  return "en";
}

const IDEA_MAP_COPY = {
  en: {
    group: "Idea map",
    topics: ["User problem", "Voice interaction", "AI reasoning layer", "Idea map", "Founder workflow"],
    whiteboard: "AI whiteboard",
    founder: "Founder decisions",
    structured: "Structured thinking",
    edges: ["starts with", "routes to", "creates"],
    spoken: "I mapped the core idea into a first structured view on the board.",
    full: "Created an idea map with nodes and relationships in the board.",
    reasoning: "The request is a thinking task, so the brain produced a compact idea-map scaffold.",
  },
  it: {
    group: "Mappa idee",
    topics: ["Obiettivo utente", "Contesto", "Passaggi chiave", "Mappa idee", "Decisioni operative"],
    whiteboard: "Lavagna AI",
    founder: "Decisioni founder",
    structured: "Pensiero strutturato",
    edges: ["inizia da", "porta a", "crea"],
    spoken: "Ho trasformato la richiesta in una prima mappa strutturata sulla lavagna.",
    full: "Ho creato una mappa con nodi e relazioni sulla lavagna.",
    reasoning: "La richiesta richiede organizzazione visiva, quindi ho prodotto una mappa compatta.",
  },
  vi: {
    group: "Ban do y tuong",
    topics: ["Muc tieu nguoi dung", "Boi canh", "Cac buoc chinh", "Ban do y tuong", "Quyet dinh tiep theo"],
    whiteboard: "Bang trang AI",
    founder: "Quyet dinh cua founder",
    structured: "Tu duy co cau truc",
    edges: ["bat dau tu", "dan den", "tao ra"],
    spoken: "Toi da chuyen yeu cau thanh mot ban do co cau truc tren bang.",
    full: "Da tao ban do y tuong voi cac nut va moi lien ket tren bang.",
    reasoning: "Yeu cau can to chuc truc quan, nen toi tao mot ban do y tuong gon.",
  },
  ja: {
    group: "Idea map",
    topics: ["User goal", "Context", "Key steps", "Idea map", "Next decisions"],
    whiteboard: "AI whiteboard",
    founder: "Founder decisions",
    structured: "Structured thinking",
    edges: ["start", "leads to", "creates"],
    spoken: "I organized the request as a structured map on the board.",
    full: "Created an idea map with nodes and relationships on the board.",
    reasoning: "The request benefits from visual organization, so I created a compact idea map.",
  },
};

function getIdeaMapCopy(language) {
  return IDEA_MAP_COPY[language] || IDEA_MAP_COPY.en;
}

function extractIdeaMapTopics(intent) {
  const text = `${intent.user_goal || ""} ${intent.known_context || ""}`;
  const copy = getIdeaMapCopy(detectLanguage(text));
  const candidates = [...copy.topics];

  if (/\bwhiteboard\b|lavagna|bảng trắng|ホワイトボード/i.test(text)) candidates[3] = copy.whiteboard;
  if (/\bfounder|startup|builder\b|fondatore|創業|創業者/i.test(text)) candidates[4] = copy.founder;
  if (/\bdesign|diagram|scheme|map\b|progetta|sơ đồ|設計|マップ/i.test(text)) candidates[0] = copy.structured;

  return candidates;
}

function buildIdeaMapOperations(intent, board) {
  const language = detectLanguage(`${intent.user_goal || ""} ${intent.known_context || ""}`);
  const copy = getIdeaMapCopy(language);
  const existingCount = board?.nodes?.length || 0;
  const baseX = 120 + (existingCount % 3) * 40;
  const baseY = 90 + Math.floor(existingCount / 3) * 80;
  const topics = extractIdeaMapTopics(intent);
  const groupId = slugId("group", intent.user_goal, existingCount);
  const nodeIds = topics.map((topic, index) => slugId("node", topic, existingCount + index));

  return [
    {
      type: "create_group",
      id: groupId,
      title: copy.group,
      node_ids: nodeIds,
    },
    ...topics.map((topic, index) => ({
      type: "create_node",
      id: nodeIds[index],
      text: topic,
      x: baseX + (index % 3) * 220,
      y: baseY + Math.floor(index / 3) * 130,
      group_id: groupId,
      emphasis: index === 0 ? "primary" : "normal",
    })),
    {
      type: "create_edge",
      id: slugId("edge", `${topics[0]}-${topics[1]}`, existingCount),
      from: nodeIds[0],
      to: nodeIds[1],
      label: copy.edges[0],
    },
    {
      type: "create_edge",
      id: slugId("edge", `${topics[1]}-${topics[2]}`, existingCount + 1),
      from: nodeIds[1],
      to: nodeIds[2],
      label: copy.edges[1],
    },
    {
      type: "create_edge",
      id: slugId("edge", `${topics[2]}-${topics[3]}`, existingCount + 2),
      from: nodeIds[2],
      to: nodeIds[3],
      label: copy.edges[2],
    },
  ];
}

function normalizeLayoutConstraints(value = {}) {
  return {
    ...DEFAULT_LAYOUT_CONSTRAINTS,
    ...(value && typeof value === "object" ? value : {}),
  };
}

function buildWhiteboardPlanInput(intent = {}, board, options = {}) {
  const artifactType = intent.target_artifact || intent.artifact_type || "board";
  const currentBoardSnapshot = board ? getBoardSnapshot(board) : {
    version: 0,
    nodes: [],
    edges: [],
    groups: [],
    operation_log: [],
    can_undo: false,
  };
  const boardContext = options.board_context || intent.board_context || buildCompactBoardContext(board);

  return {
    artifact_type: artifactType,
    artifact_description: intent.artifact_description || intent.full_response || intent.reason || intent.user_goal || "",
    user_goal: intent.user_goal || "",
    compact_session_context: intent.known_context || intent.compact_session_context || "",
    current_board_snapshot: currentBoardSnapshot,
    board_context: boardContext,
    supported_operation_types: getSupportedOperationTypes().filter((type) => type !== "undo"),
    layout_constraints: normalizeLayoutConstraints(options.layout_constraints || intent.layout_constraints),
    allow_destructive_operations: intent.allow_destructive_operations === true,
  };
}

function parseModelJson(data) {
  const raw = data?.output_text
    || data?.output?.flatMap((item) => item.content || []).find((content) => content.type === "output_text")?.text
    || "";
  return JSON.parse(raw || "{}");
}

function normalizePlannerOutput(rawOutput = {}) {
  const output = rawOutput && typeof rawOutput === "object" ? rawOutput : {};
  if (!Array.isArray(output.board_operations)) {
    throw new Error("Whiteboard planner response is missing board_operations.");
  }

  return {
    spoken_summary: String(output.spoken_summary || ""),
    reasoning_summary: String(output.reasoning_summary || ""),
    board_operations: output.board_operations,
    layout_notes: String(output.layout_notes || ""),
    missing_info: Array.isArray(output.missing_info) ? output.missing_info.map(String) : [],
  };
}

async function callWhiteboardPlannerModel(planInput, options = {}) {
  if (options.plannerProvider) {
    return normalizePlannerOutput(await options.plannerProvider(planInput));
  }

  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY; using deterministic whiteboard fixture.");
  }

  const model = options.model || selectModel({
    role: MODEL_ROLES.whiteboard_planner,
    complexity: options.complexity || "medium",
    latency_budget: options.latency_budget || "medium",
    artifact_type: planInput.artifact_type,
  }).model;
  const fetchImpl = options.fetchImpl || fetch;
  const systemPrompt = [
    "You are a whiteboard planner for a voice-first AI whiteboard.",
    "Turn high-level artifact intent into a small batch of board operations.",
    "Extend, refine, or reorganize existing board structures when useful instead of always starting from scratch.",
    "Use only supported operation types and preserve user edits reflected in the board context.",
    "Respect layout constraints: keep coordinates finite, nodes spaced, groups readable, and edge endpoints valid.",
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
        { role: "user", content: JSON.stringify(planInput) },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "whiteboard_plan",
          schema: {
            type: "object",
            properties: {
              spoken_summary: { type: "string" },
              reasoning_summary: { type: "string" },
              board_operations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {},
                  additionalProperties: true,
                },
              },
              layout_notes: { type: "string" },
              missing_info: { type: "array", items: { type: "string" } },
            },
            required: ["spoken_summary", "reasoning_summary", "board_operations", "layout_notes", "missing_info"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "Whiteboard planner model request failed");
  }

  return normalizePlannerOutput(parseModelJson(data));
}

function buildFallbackPlan(intent, board, planInput, modelSelection, options = {}, fallbackReason = "", sourceWarnings = []) {
  const language = detectLanguage(`${intent.user_goal || ""} ${intent.known_context || ""}`);
  const copy = getIdeaMapCopy(language);
  const operationBuilder = options.operationBuilder || buildIdeaMapOperations;
  const rawBoardOperations = intent?.intent_type === "develop_idea_map" && planInput.artifact_type === "idea_map"
    ? operationBuilder(intent, board, planInput)
    : [];
  const validation = validateBoardOperations(rawBoardOperations, board, {
    allowDestructive: planInput.allow_destructive_operations,
  });

  return {
    handled_by: "whiteboard_planner",
    model: options.model || modelSelection.model,
    model_role: modelSelection.role,
    artifact_type: planInput.artifact_type,
    board_context: planInput.board_context,
    planner_input: planInput,
    spoken_summary: copy.spoken,
    reasoning_summary: fallbackReason ? `${copy.reasoning} Fallback planner used: ${fallbackReason}` : copy.reasoning,
    layout_notes: "Deterministic fixture layout: compact grid, grouped nodes, and short labeled edges.",
    missing_info: [],
    raw_board_operations: rawBoardOperations,
    board_operations: validation.validOperations,
    validation_warnings: [...sourceWarnings, ...validation.warnings],
    used_fallback: true,
  };
}

async function planWhiteboardOperations(intent, board, options = {}) {
  const planInput = buildWhiteboardPlanInput(intent, board, options);
  const artifactType = planInput.artifact_type;
  const boardContext = planInput.board_context;
  const modelSelection = selectModel({
    role: MODEL_ROLES.whiteboard_planner,
    complexity: options.complexity || "medium",
    latency_budget: options.latency_budget || "medium",
    artifact_type: artifactType,
  });

  if (intent?.intent_type === "develop_idea_map" && artifactType === "idea_map") {
    try {
      const plannerOutput = await callWhiteboardPlannerModel(planInput, options);
      const validation = validateBoardOperations(plannerOutput.board_operations, board, {
        allowDestructive: planInput.allow_destructive_operations,
      });

      if (validation.warnings.length) {
        return buildFallbackPlan(
          intent,
          board,
          planInput,
          modelSelection,
          options,
          "planner returned invalid operations",
          validation.warnings
        );
      }

      return {
        handled_by: "whiteboard_planner",
        model: options.model || modelSelection.model,
        model_role: modelSelection.role,
        artifact_type: artifactType,
        board_context: boardContext,
        planner_input: planInput,
        spoken_summary: plannerOutput.spoken_summary,
        reasoning_summary: plannerOutput.reasoning_summary,
        layout_notes: plannerOutput.layout_notes,
        missing_info: plannerOutput.missing_info,
        raw_board_operations: plannerOutput.board_operations,
        board_operations: validation.validOperations,
        validation_warnings: [],
        used_fallback: false,
      };
    } catch (error) {
      return buildFallbackPlan(intent, board, planInput, modelSelection, options, error.message);
    }
  }

  return {
    handled_by: "whiteboard_planner",
    model: options.model || modelSelection.model,
    model_role: modelSelection.role,
    artifact_type: artifactType,
    board_context: boardContext,
    planner_input: planInput,
    spoken_summary: "",
    reasoning_summary: "",
    layout_notes: "",
    missing_info: [],
    raw_board_operations: [],
    board_operations: [],
    validation_warnings: [],
    used_fallback: false,
  };
}

module.exports = {
  planWhiteboardOperations,
  buildWhiteboardPlanInput,
  detectLanguage,
  getIdeaMapCopy,
};
