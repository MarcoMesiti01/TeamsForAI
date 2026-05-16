const { searchFlights, saveFlightsToFile } = require("./flightTools");
const { routeUserIntent } = require("./intentRouter");
const { applyBoardOperations } = require("./boardState");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BRAIN_MODEL = process.env.BRAIN_MODEL || "gpt-4.1-mini";

function isFlightTask(taskType, userGoal) {
  const text = `${taskType || ""} ${userGoal || ""}`.toLowerCase();
  return /(flight|flights|fare|airline|airport|cheapest|from .* to )/.test(text);
}

async function callBrainModel(input) {
  if (!OPENAI_API_KEY) {
    return {
      handled_by: "brain",
      spoken_summary: "I need a configured OpenAI API key to complete this request.",
      full_response: "Missing OPENAI_API_KEY on backend.",
      reasoning_summary: "The backend cannot call the configured brain model without an API key.",
      board_operations: [],
      undo_checkpoint_id: null,
      missing_info: ["OPENAI_API_KEY"],
      usage: null,
    };
  }

  const systemPrompt = [
    "You are the non-realtime Brain model behind a voice controller.",
    "Keep spoken_summary concise (1-2 sentences).",
    "If critical details are missing, return them in missing_info and ask concise follow-up.",
    "Return strict JSON with keys: spoken_summary, full_response, reasoning_summary, missing_info.",
  ].join(" ");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: BRAIN_MODEL,
      input: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify(input),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "brain_delegate_response",
          schema: {
            type: "object",
            properties: {
              spoken_summary: { type: "string" },
              full_response: { type: "string" },
              reasoning_summary: { type: "string" },
              missing_info: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["spoken_summary", "full_response", "reasoning_summary", "missing_info"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "Brain model request failed");
  }

  const raw = data.output_text || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      spoken_summary: "I completed the request.",
      full_response: raw,
      reasoning_summary: "The brain returned non-JSON text, so the raw response was preserved.",
      missing_info: [],
    };
  }

  return {
    handled_by: "brain",
    ...parsed,
    board_operations: [],
    undo_checkpoint_id: null,
    usage: data.usage || null,
  };
}

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
    group: "Bản đồ ý tưởng",
    topics: ["Mục tiêu người dùng", "Bối cảnh", "Các bước chính", "Bản đồ ý tưởng", "Quyết định tiếp theo"],
    whiteboard: "Bảng trắng AI",
    founder: "Quyết định của founder",
    structured: "Tư duy có cấu trúc",
    edges: ["bắt đầu từ", "dẫn đến", "tạo ra"],
    spoken: "Tôi đã chuyển yêu cầu thành một bản đồ có cấu trúc trên bảng.",
    full: "Đã tạo bản đồ ý tưởng với các nút và mối liên kết trên bảng.",
    reasoning: "Yêu cầu cần tổ chức trực quan, nên tôi tạo một bản đồ ý tưởng gọn.",
  },
  ja: {
    group: "アイデアマップ",
    topics: ["ユーザー目標", "文脈", "主要ステップ", "アイデアマップ", "次の判断"],
    whiteboard: "AIホワイトボード",
    founder: "創業者の判断",
    structured: "構造化された思考",
    edges: ["始点", "つながる", "作成"],
    spoken: "依頼内容を構造化したマップとしてボードに整理しました。",
    full: "ボード上にノードと関係を持つアイデアマップを作成しました。",
    reasoning: "視覚的に整理する依頼なので、コンパクトなアイデアマップを作成しました。",
  },
};

function extractIdeaMapTopics(intent) {
  const text = `${intent.user_goal || ""} ${intent.known_context || ""}`;
  const copy = IDEA_MAP_COPY[detectLanguage(text)] || IDEA_MAP_COPY.en;
  const candidates = [...copy.topics];

  if (/\bwhiteboard\b|lavagna|bảng trắng|ホワイトボード/i.test(text)) candidates[3] = copy.whiteboard;
  if (/\bfounder|startup|builder\b|fondatore|創業|創業者/i.test(text)) candidates[4] = copy.founder;
  if (/\bdesign|diagram|scheme|map\b|progetta|sơ đồ|設計|マップ/i.test(text)) candidates[0] = copy.structured;

  return candidates;
}

function buildIdeaMapOperations(intent, board) {
  const language = detectLanguage(`${intent.user_goal || ""} ${intent.known_context || ""}`);
  const copy = IDEA_MAP_COPY[language] || IDEA_MAP_COPY.en;
  const existingCount = board?.nodes?.length || 0;
  const baseX = 120 + (existingCount % 3) * 40;
  const baseY = 90 + Math.floor(existingCount / 3) * 80;
  const topics = extractIdeaMapTopics(intent);
  const groupId = slugId("group", intent.user_goal, existingCount);
  const nodeIds = topics.map((topic, index) => slugId("node", topic, existingCount + index));

  const operations = [
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

  return operations;
}

async function delegateToBrain(payload, sessionState) {
  const normalized = payload?.intent_type
    ? payload
    : routeUserIntent({
        user_goal: payload?.user_goal || "",
        collected_context: payload?.collected_context || "",
        missing_info: payload?.missing_info,
      });

  sessionState.last_task_type = normalized.intent_type || normalized.task_type;
  sessionState.last_user_goal = normalized.user_goal;

  if (normalized.intent_type === "develop_idea_map" && normalized.target_artifact === "idea_map") {
    const boardOperations = buildIdeaMapOperations(normalized, sessionState.board);
    const applied = applyBoardOperations(sessionState.board, boardOperations, { source: "ai" });
    const language = detectLanguage(`${normalized.user_goal || ""} ${normalized.known_context || ""}`);
    const copy = IDEA_MAP_COPY[language] || IDEA_MAP_COPY.en;
    return {
      handled_by: "brain",
      spoken_summary: copy.spoken,
      full_response: copy.full,
      reasoning_summary: copy.reasoning,
      missing_info: [],
      board_operations: boardOperations,
      undo_checkpoint_id: applied.undo_checkpoint_id,
      board_state: applied.board_state,
      usage: null,
    };
  }

  if (isFlightTask(normalized.intent_type || normalized.task_type, normalized.user_goal)) {
    const search = searchFlights(payload);
    if (!search.ok) {
      return {
        handled_by: "brain",
        spoken_summary: "I need date, origin, and destination to search flights.",
        full_response: search.error,
        reasoning_summary: "The flight workflow requires origin, destination, and date before tool execution.",
        board_operations: [],
        undo_checkpoint_id: null,
        missing_info: ["origin", "destination", "date"],
        usage: null,
      };
    }

    const save = await saveFlightsToFile({ query: search.query, flights: search.flights });
    return {
      handled_by: "brain",
      spoken_summary: search.count
        ? `I found ${search.count} options and saved the cheapest flights to flights found.txt.`
        : "No matching flights were found in the current dataset. I still updated flights found.txt.",
      full_response: `${search.summary}\n\nSaved: ${save.file_path}`,
      reasoning_summary: "The brain used the existing flight workflow and did not change the board.",
      missing_info: [],
      board_operations: [],
      undo_checkpoint_id: null,
      search,
      save,
      usage: null,
    };
  }

  const brainResult = await callBrainModel({
    ...normalized,
    compact_session_state: {
      last_task_type: sessionState.last_task_type,
      last_user_goal: sessionState.last_user_goal,
    },
  });

  if (brainResult.usage) {
    console.log("[brain usage]", brainResult.usage);
  }

  return brainResult;
}

module.exports = {
  delegateToBrain,
};
