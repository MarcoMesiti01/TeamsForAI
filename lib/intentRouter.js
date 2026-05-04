const SUPPORTED_INTENTS = new Set([
  "develop_idea_map",
  "answer_simple",
  "undo",
]);

function normalizeText(value) {
  return String(value || "").trim();
}

function detectIntentType(goal) {
  const text = goal.toLowerCase();
  if (/\bundo\b|\bgo back\b|\brevert\b/.test(text)) return "undo";
  if (/\b(map|whiteboard|idea|brainstorm|strategy|product|startup|founder|diagram|scheme|plan|design)\b/.test(text)) {
    return "develop_idea_map";
  }
  if (/\b(help me think|think through|work through|figure out|break down|organize|structure|explore|compare|prioritize|roadmap|flow|workflow|user journey|onboarding|features?)\b/.test(text)) {
    return "develop_idea_map";
  }
  return "answer_simple";
}

function routeUserIntent(payload = {}) {
  const userGoal = normalizeText(payload.user_goal || payload.userGoal || payload.goal);
  if (!userGoal) {
    throw new Error("user_goal is required");
  }

  const intentType = detectIntentType(userGoal);
  if (!SUPPORTED_INTENTS.has(intentType)) {
    throw new Error(`Unsupported intent type: ${intentType}`);
  }

  const knownContext = normalizeText(payload.collected_context || payload.known_context);
  const targetArtifact = intentType === "develop_idea_map" ? "idea_map" : "conversation";
  const confidence = intentType === "develop_idea_map" ? 0.86 : 0.72;

  return {
    intent_type: intentType,
    user_goal: userGoal,
    target_artifact: targetArtifact,
    known_context: knownContext,
    missing_info: Array.isArray(payload.missing_info) ? payload.missing_info : [],
    confidence,
  };
}

module.exports = {
  routeUserIntent,
};
