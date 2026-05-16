const { MODEL_ROLES, selectModel } = require("./modelPolicy");

function slugId(prefix, text, index) {
  const slug = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 28) || "item";
  return `${prefix}-${index + 1}-${slug}`;
}

function extractIdeaMapTopics(intent) {
  const text = `${intent.user_goal || ""} ${intent.known_context || ""}`;
  const candidates = [
    "User problem",
    "Voice interaction",
    "AI reasoning layer",
    "Idea map",
    "Founder workflow",
  ];

  if (/\bwhiteboard\b/i.test(text)) candidates[3] = "AI whiteboard";
  if (/\bfounder|startup|builder\b/i.test(text)) candidates[4] = "Founder decisions";
  if (/\bdesign|diagram|scheme|map\b/i.test(text)) candidates[0] = "Structured thinking";

  return candidates;
}

function buildIdeaMapOperations(intent, board) {
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
      title: "Idea map",
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
      label: "starts with",
    },
    {
      type: "create_edge",
      id: slugId("edge", `${topics[1]}-${topics[2]}`, existingCount + 1),
      from: nodeIds[1],
      to: nodeIds[2],
      label: "routes to",
    },
    {
      type: "create_edge",
      id: slugId("edge", `${topics[2]}-${topics[3]}`, existingCount + 2),
      from: nodeIds[2],
      to: nodeIds[3],
      label: "creates",
    },
  ];
}

function planWhiteboardOperations(intent, board, options = {}) {
  const artifactType = intent?.target_artifact || intent?.artifact_type || "board";
  const modelSelection = selectModel({
    role: MODEL_ROLES.whiteboard_planner,
    complexity: options.complexity || "medium",
    latency_budget: options.latency_budget || "medium",
    artifact_type: artifactType,
  });

  if (intent?.intent_type === "develop_idea_map" && artifactType === "idea_map") {
    return {
      handled_by: "whiteboard_planner",
      model: options.model || modelSelection.model,
      model_role: modelSelection.role,
      artifact_type: artifactType,
      board_operations: buildIdeaMapOperations(intent, board),
    };
  }

  return {
    handled_by: "whiteboard_planner",
    model: options.model || modelSelection.model,
    model_role: modelSelection.role,
    artifact_type: artifactType,
    board_operations: [],
  };
}

module.exports = {
  planWhiteboardOperations,
};
