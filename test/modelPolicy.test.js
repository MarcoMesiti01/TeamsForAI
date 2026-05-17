const test = require("node:test");
const assert = require("node:assert/strict");

const { MODEL_ROLES, selectModel } = require("../lib/modelPolicy");

test("selects role defaults from environment variables", () => {
  const previous = process.env.BRAIN_MODEL;
  process.env.BRAIN_MODEL = "test-brain-model";

  const selection = selectModel({
    role: MODEL_ROLES.brain_reasoner,
    complexity: "high",
    latency_budget: "relaxed",
    artifact_type: "idea_map",
  });

  assert.equal(selection.model, "test-brain-model");
  assert.equal(selection.role, MODEL_ROLES.brain_reasoner);
  assert.equal(selection.complexity, "high");
  assert.equal(selection.artifact_type, "idea_map");

  if (previous === undefined) {
    delete process.env.BRAIN_MODEL;
  } else {
    process.env.BRAIN_MODEL = previous;
  }
});

test("throws for unsupported model roles", () => {
  assert.throws(() => selectModel({ role: "unknown" }), /Unsupported model role/);
});

test("uses the GA realtime model fallback", () => {
  const previous = process.env.DEFAULT_REALTIME_MODEL;
  delete process.env.DEFAULT_REALTIME_MODEL;

  const selection = selectModel({
    role: MODEL_ROLES.realtime_controller,
    latency_budget: "realtime",
  });

  assert.equal(selection.model, "gpt-realtime");

  if (previous !== undefined) {
    process.env.DEFAULT_REALTIME_MODEL = previous;
  }
});
