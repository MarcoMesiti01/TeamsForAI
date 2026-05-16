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

test("routes process description requests to the board", () => {
  const intent = routeUserIntent({
    user_goal: "Describe the process for refund approval",
  });

  assert.equal(intent.intent_type, "develop_idea_map");
  assert.equal(intent.target_artifact, "idea_map");
});

test("trusts explicit multilingual semantic intent from the realtime model", () => {
  const intent = routeUserIntent({
    user_goal: "返金承認のプロセスを説明してください",
    intent_type: "develop_idea_map",
    target_artifact: "idea_map",
  });

  assert.equal(intent.intent_type, "develop_idea_map");
  assert.equal(intent.target_artifact, "idea_map");
});

test("uses multilingual fallback when no explicit intent is provided", () => {
  const italian = routeUserIntent({ user_goal: "Descrivi il processo di approvazione dei rimborsi" });
  const vietnamese = routeUserIntent({ user_goal: "Mô tả quy trình phê duyệt hoàn tiền" });
  const japanese = routeUserIntent({ user_goal: "返金承認のプロセスを説明してください" });

  assert.equal(italian.intent_type, "develop_idea_map");
  assert.equal(vietnamese.intent_type, "develop_idea_map");
  assert.equal(japanese.intent_type, "develop_idea_map");
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
