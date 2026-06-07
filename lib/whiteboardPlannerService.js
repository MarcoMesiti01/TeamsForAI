const { MODEL_ROLES, selectModel } = require("./modelPolicy");
const { buildCompactBoardContext } = require("./boardContext");
const { getBoardSnapshot, getSupportedOperationTypes } = require("./boardState");
const { validateBoardOperations } = require("./boardOperationValidator");

function recordEvent(options = {}, event = {}) {
  const recorder = options.recorder;
  if (!recorder || typeof recorder.recordEvent !== "function") {
    return null;
  }

  try {
    const result = recorder.recordEvent({
      session_id: options.sessionId || options.session_id || "default",
      trace_id: options.traceId || options.trace_id,
      ...event,
    });

    if (result && typeof result.then === "function") {
      result.catch(() => {});
    }

    return result;
  } catch {
    return null;
  }
}

const DEFAULT_LAYOUT_CONSTRAINTS = Object.freeze({
  canvas_width: 1200,
  canvas_height: 900,
  node_width: 210,
  node_height: 112,
  min_node_spacing: 180,
  group_padding: 28,
  edge_readability: "prefer short curved edges with clear labels and avoid crossing existing links when possible",
});

const VISUAL_ARTIFACT_TYPES = new Set([
  "idea_map",
  "process_flow",
  "architecture_map",
  "comparison_map",
  "action_plan",
]);

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

function buildLinearArtifactOperations(intent, board, config) {
  const existingCount = board?.nodes?.length || 0;
  const baseX = 120 + (existingCount % 3) * 40;
  const baseY = 90 + Math.floor(existingCount / 3) * 80;
  const groupId = slugId("group", `${config.group} ${intent.user_goal}`, existingCount);
  const nodeIds = config.nodes.map((topic, index) => slugId("node", topic, existingCount + index));
  const nodeOperations = config.nodes.map((topic, index) => ({
    type: "create_node",
    id: nodeIds[index],
    text: topic,
    x: baseX + index * 220,
    y: baseY,
    group_id: groupId,
    emphasis: index === 0 ? "primary" : "normal",
  }));
  const edgeOperations = nodeIds.slice(0, -1).map((id, index) => ({
    type: "create_edge",
    id: slugId("edge", `${config.nodes[index]}-${config.nodes[index + 1]}`, existingCount + index),
    from: id,
    to: nodeIds[index + 1],
    label: config.edgeLabels[index] || "then",
  }));

  return [
    { type: "create_group", id: groupId, title: config.group, node_ids: nodeIds },
    ...nodeOperations,
    ...edgeOperations,
  ];
}

function buildClusterArtifactOperations(intent, board, config) {
  const existingCount = board?.nodes?.length || 0;
  const baseX = 120 + (existingCount % 3) * 40;
  const baseY = 90 + Math.floor(existingCount / 3) * 80;
  const groupId = slugId("group", `${config.group} ${intent.user_goal}`, existingCount);
  const nodeIds = config.nodes.map((topic, index) => slugId("node", topic, existingCount + index));
  const nodeOperations = config.nodes.map((topic, index) => ({
    type: "create_node",
    id: nodeIds[index],
    text: topic,
    x: baseX + (index % 3) * 230,
    y: baseY + Math.floor(index / 3) * 140,
    group_id: groupId,
    emphasis: index === 0 ? "primary" : "normal",
  }));
  const edgeOperations = config.edges.map(([fromIndex, toIndex, label], index) => ({
    type: "create_edge",
    id: slugId("edge", `${config.nodes[fromIndex]}-${config.nodes[toIndex]}`, existingCount + index),
    from: nodeIds[fromIndex],
    to: nodeIds[toIndex],
    label,
  }));

  return [
    { type: "create_group", id: groupId, title: config.group, node_ids: nodeIds },
    ...nodeOperations,
    ...edgeOperations,
  ];
}

function buildProcessFlowOperations(intent, board) {
  return buildLinearArtifactOperations(intent, board, {
    group: "Process flow",
    nodes: ["Trigger", "Input", "Core steps", "Decision point", "Outcome"],
    edgeLabels: ["starts", "feeds", "requires", "produces"],
  });
}

function buildArchitectureMapOperations(intent, board) {
  return buildClusterArtifactOperations(intent, board, {
    group: "Architecture map",
    nodes: ["User interaction", "Orchestrator", "Reasoning layer", "Whiteboard planner", "Board state", "Undo log"],
    edges: [
      [0, 1, "sends intent"],
      [1, 2, "delegates"],
      [2, 3, "requests visual plan"],
      [3, 4, "writes operations"],
      [4, 5, "records checkpoint"],
    ],
  });
}

function buildComparisonMapOperations(intent, board) {
  return buildClusterArtifactOperations(intent, board, {
    group: "Comparison map",
    nodes: ["Decision criteria", "Option A", "Option B", "Trade-offs", "Recommendation"],
    edges: [
      [0, 1, "scores"],
      [0, 2, "scores"],
      [1, 3, "reveals"],
      [2, 3, "reveals"],
      [3, 4, "supports"],
    ],
  });
}

function buildActionPlanOperations(intent, board) {
  return buildLinearArtifactOperations(intent, board, {
    group: "Action plan",
    nodes: ["Goal", "First action", "Next milestone", "Owner / decision", "Success check"],
    edgeLabels: ["defines", "leads to", "needs", "validated by"],
  });
}

function buildFallbackOperations(intent, board, planInput) {
  const artifactType = planInput.artifact_type;
  if (artifactType === "process_flow") return buildProcessFlowOperations(intent, board);
  if (artifactType === "architecture_map") return buildArchitectureMapOperations(intent, board);
  if (artifactType === "comparison_map") return buildComparisonMapOperations(intent, board);
  if (artifactType === "action_plan") return buildActionPlanOperations(intent, board);
  return buildIdeaMapOperations(intent, board);
}

function normalizeLayoutConstraints(value = {}) {
  return {
    ...DEFAULT_LAYOUT_CONSTRAINTS,
    ...(value && typeof value === "object" ? value : {}),
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value && Object.prototype.toString.call(value) === "[object Object]");
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
    board_strategy: intent.board_strategy || "create_new_group",
    visual_summary_goal: intent.visual_summary_goal || intent.artifact_description || intent.reason || "",
    artifact_description: intent.artifact_description || intent.full_response || intent.reason || intent.user_goal || "",
    user_goal: intent.user_goal || "",
    compact_session_context: intent.known_context || intent.compact_session_context || "",
    workspace_context: isPlainObject(intent.workspace_context) ? clone(intent.workspace_context) : null,
    sync_reason: intent.sync_reason || null,
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
    const rawOutput = await options.plannerProvider(clone(planInput));
    return {
      raw_output: clone(rawOutput),
      normalized_output: normalizePlannerOutput(rawOutput),
    };
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
    "Active committed workspace entries are authoritative; reuse/update related nodes where possible.",
    "Tag nodes that directly represent workspace entries with workspace_entry_id, memory_status, origin.",
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

  const rawOutput = parseModelJson(data);
  return {
    raw_output: rawOutput,
    normalized_output: normalizePlannerOutput(rawOutput),
  };
}

function buildFallbackPlan(intent, board, planInput, modelSelection, options = {}, fallbackReason = "", sourceWarnings = []) {
  const language = detectLanguage(`${intent.user_goal || ""} ${intent.known_context || ""}`);
  const copy = getIdeaMapCopy(language);
  const operationBuilder = options.operationBuilder || buildFallbackOperations;
  const rawBoardOperations = (intent?.should_use_whiteboard === true || VISUAL_ARTIFACT_TYPES.has(planInput.artifact_type))
    ? operationBuilder(intent, board, planInput)
    : [];
  const validation = validateBoardOperations(rawBoardOperations, board, {
    allowDestructive: planInput.allow_destructive_operations,
  });
  const normalizedOutput = {
    spoken_summary: copy.spoken,
    reasoning_summary: fallbackReason ? `${copy.reasoning} Fallback planner used: ${fallbackReason}` : copy.reasoning,
    board_operations: validation.validOperations,
    layout_notes: `Deterministic ${planInput.artifact_type} layout: compact grouped nodes with readable labeled edges.`,
    missing_info: [],
  };

  recordEvent(options, {
    category: "model",
    action: "whiteboard_planner_fallback",
    status: "completed",
    summary: fallbackReason || "deterministic whiteboard fallback",
    payload: {
      planner_input: planInput,
      raw_output: rawBoardOperations,
      normalized_output: normalizedOutput,
      warnings: [...sourceWarnings, ...validation.warnings],
      model: options.model || modelSelection.model,
      model_role: modelSelection.role,
    },
  });

  recordEvent(options, {
    category: "board",
    action: "validate_operations",
    status: validation.warnings.length ? "warning" : "completed",
    summary: "validated fallback whiteboard operations",
    payload: {
      planner_input: planInput,
      raw_operations: rawBoardOperations,
      valid_operations: validation.validOperations,
      warnings: [...sourceWarnings, ...validation.warnings],
      model: options.model || modelSelection.model,
      model_role: modelSelection.role,
      normalized_output: normalizedOutput,
    },
  });

  return {
    handled_by: "whiteboard_planner",
    model: options.model || modelSelection.model,
    model_role: modelSelection.role,
    artifact_type: planInput.artifact_type,
    board_strategy: planInput.board_strategy,
    board_context: planInput.board_context,
    planner_input: planInput,
    spoken_summary: normalizedOutput.spoken_summary,
    reasoning_summary: normalizedOutput.reasoning_summary,
    layout_notes: normalizedOutput.layout_notes,
    missing_info: normalizedOutput.missing_info,
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

  if (intent?.should_use_whiteboard === true || VISUAL_ARTIFACT_TYPES.has(artifactType)) {
    try {
      recordEvent(options, {
        category: "model",
        action: "whiteboard_planner",
        status: "started",
        summary: "planning whiteboard operations",
        payload: {
          planner_input: planInput,
          model: options.model || modelSelection.model,
          model_role: modelSelection.role,
        },
      });

      const plannerResult = await callWhiteboardPlannerModel(planInput, options);
      const plannerOutput = plannerResult.normalized_output;
      const validation = validateBoardOperations(plannerOutput.board_operations, board, {
        allowDestructive: planInput.allow_destructive_operations,
      });

      recordEvent(options, {
        category: "model",
        action: "whiteboard_planner",
        status: "completed",
        summary: "whiteboard planner returned operations",
        payload: {
          planner_input: planInput,
          raw_output: plannerResult.raw_output,
          normalized_output: plannerOutput,
          model: options.model || modelSelection.model,
          model_role: modelSelection.role,
        },
      });

      recordEvent(options, {
        category: "board",
        action: "validate_operations",
        status: validation.warnings.length ? "warning" : "completed",
        summary: validation.warnings.length ? "whiteboard operations required fallback" : "validated whiteboard operations",
        payload: {
          planner_input: planInput,
          raw_operations: plannerOutput.board_operations,
          valid_operations: validation.validOperations,
          warnings: validation.warnings,
          model: options.model || modelSelection.model,
          model_role: modelSelection.role,
          normalized_output: plannerOutput,
        },
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
        board_strategy: planInput.board_strategy,
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
      recordEvent(options, {
        category: "model",
        action: "whiteboard_planner",
        status: "failed",
        summary: "whiteboard planner failed",
        payload: {
          planner_input: planInput,
          model: options.model || modelSelection.model,
          model_role: modelSelection.role,
          error: error.message,
        },
      });
      return buildFallbackPlan(intent, board, planInput, modelSelection, options, error.message);
    }
  }

  return {
    handled_by: "whiteboard_planner",
    model: options.model || modelSelection.model,
    model_role: modelSelection.role,
    artifact_type: artifactType,
    board_strategy: planInput.board_strategy,
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
