const test = require("node:test");
const assert = require("node:assert/strict");

const { routeUserIntent } = require("../lib/intentRouter");

test("routes founder idea-map requests into structured intent JSON", () => {
  const intent = routeUserIntent({
    user_goal: "Help me map an AI whiteboard product for startup founders",
    collected_context: "We want voice-first thinking and diagrams.",
  });

  assert.equal(intent.intent_type, "develop_idea_map");
  assert.equal(intent.target_artifact, "idea_map");
  assert.equal(intent.user_goal, "Help me map an AI whiteboard product for startup founders");
  assert.deepEqual(intent.missing_info, []);
  assert.equal(typeof intent.known_context, "string");
  assert.ok(intent.confidence >= 0.5);
});

test("routes lightweight thinking requests to the board before they become complex", () => {
  const intent = routeUserIntent({
    user_goal: "Help me think through the onboarding flow for this app",
  });

  assert.equal(intent.intent_type, "develop_idea_map");
  assert.equal(intent.target_artifact, "idea_map");
});

test("keeps casual conversation off the board", () => {
  const intent = routeUserIntent({
    user_goal: "Good morning, how are you?",
  });

  assert.equal(intent.intent_type, "answer_simple");
  assert.equal(intent.target_artifact, "conversation");
});

test("rejects unsupported router payloads instead of returning free-form actions", () => {
  assert.throws(
    () => routeUserIntent({ user_goal: "" }),
    /user_goal is required/
  );
});
