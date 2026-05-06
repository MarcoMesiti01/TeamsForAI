const MODEL_ROLES = Object.freeze({
  realtime_controller: "realtime_controller",
  orchestrator: "orchestrator",
  brain_reasoner: "brain_reasoner",
  whiteboard_planner: "whiteboard_planner",
  summarizer: "summarizer",
});

const ROLE_DEFAULTS = Object.freeze({
  [MODEL_ROLES.realtime_controller]: {
    env: "DEFAULT_REALTIME_MODEL",
    fallback: "gpt-4o-realtime-preview",
  },
  [MODEL_ROLES.orchestrator]: {
    env: "ORCHESTRATOR_MODEL",
    fallback: "gpt-4.1-mini",
  },
  [MODEL_ROLES.brain_reasoner]: {
    env: "BRAIN_MODEL",
    fallback: "gpt-4.1-mini",
  },
  [MODEL_ROLES.whiteboard_planner]: {
    env: "WHITEBOARD_MODEL",
    fallback: "gpt-4.1-mini",
  },
  [MODEL_ROLES.summarizer]: {
    env: "SUMMARIZER_MODEL",
    fallback: "gpt-4.1-mini",
  },
});

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeComplexity(complexity) {
  const value = normalizeText(complexity).toLowerCase();
  if (["low", "medium", "high"].includes(value)) return value;
  return "medium";
}

function normalizeLatencyBudget(latencyBudget) {
  const value = normalizeText(latencyBudget).toLowerCase();
  if (["realtime", "low", "medium", "relaxed"].includes(value)) return value;
  return "medium";
}

function getRoleDefault(role) {
  const config = ROLE_DEFAULTS[role];
  if (!config) {
    throw new Error(`Unsupported model role: ${role}`);
  }

  return normalizeText(process.env[config.env]) || config.fallback;
}

function selectModel({ role, complexity = "medium", latency_budget = "medium", artifact_type = "conversation" } = {}) {
  if (!role) {
    throw new Error("role is required for model selection");
  }

  const normalizedRole = normalizeText(role);
  const normalizedComplexity = normalizeComplexity(complexity);
  const normalizedLatencyBudget = normalizeLatencyBudget(latency_budget);
  const normalizedArtifactType = normalizeText(artifact_type) || "conversation";
  const model = getRoleDefault(normalizedRole);

  return {
    role: normalizedRole,
    model,
    complexity: normalizedComplexity,
    latency_budget: normalizedLatencyBudget,
    artifact_type: normalizedArtifactType,
    source: ROLE_DEFAULTS[normalizedRole].env,
  };
}

module.exports = {
  MODEL_ROLES,
  selectModel,
};
