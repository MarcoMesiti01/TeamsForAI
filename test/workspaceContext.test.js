const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CATEGORIES,
  createReasoningWorkspace,
  applyWorkspaceOperations,
  getWorkspaceSnapshot,
} = require("../lib/reasoningWorkspace");
const {
  buildCompactWorkspaceContext,
  buildRealtimeWorkspaceBriefing,
} = require("../lib/workspaceContext");

function createPopulatedWorkspace() {
  const workspace = createReasoningWorkspace();
  applyWorkspaceOperations(workspace, [
    {
      type: "update_working_memory",
      summary: "Choosing a deployment strategy",
      current_topic: "Deployment strategy",
      candidate_options: ["Blue-green", "Canary"],
      provisional_observations: ["Canary may reduce launch risk"],
      unresolved_references: ["Confirm operations staffing"],
      board_focus: "deployment-map",
    },
    {
      type: "add_entry",
      id: "problem-1",
      category: "problem",
      content: "The team needs a safer deployment path",
      origin: "user_stated",
      source_turn_id: "turn-1",
    },
    {
      type: "add_entry",
      id: "objective-1",
      category: "objectives",
      content: "Reduce release risk",
      origin: "user_stated",
      source_turn_id: "turn-1",
    },
    {
      type: "add_entry",
      id: "assumption-1",
      category: "assumptions",
      content: "Existing CI is stable",
      origin: "ai_inferred",
      source_turn_id: "turn-1",
    },
    {
      type: "add_entry",
      id: "constraint-1",
      category: "constraints",
      content: "Must avoid weekend releases",
      origin: "ai_inferred",
      source_turn_id: "turn-1",
    },
    {
      type: "add_entry",
      id: "criteria-1",
      category: "criteria",
      content: "Operational confidence",
      origin: "ai_inferred",
      source_turn_id: "turn-1",
    },
  ], { source: "coordinator", turn_id: "turn-1" });
  applyWorkspaceOperations(workspace, [
    {
      type: "correct_entry",
      id: "constraint-1",
      replacement_id: "objective-2",
      category: "objectives",
      content: "Prefer weekday releases",
      origin: "user_stated",
      source_turn_id: "turn-2",
    },
    {
      type: "remove_entry",
      id: "assumption-1",
      category: "assumptions",
      content: "Existing CI is stable",
      origin: "user_stated",
      source_turn_id: "turn-2",
    },
  ], { source: "coordinator", turn_id: "turn-2" });
  return workspace;
}

test("compact context groups only active committed entries by every category", () => {
  const workspace = createPopulatedWorkspace();

  const context = buildCompactWorkspaceContext(workspace);

  assert.deepEqual(Object.keys(context.active_entries), Array.from(CATEGORIES));
  assert.deepEqual(context.active_entries.objectives, [
    {
      id: "objective-1",
      content: "Reduce release risk",
      origin: "user_stated",
      source_turn_id: "turn-1",
    },
    {
      id: "objective-2",
      content: "Prefer weekday releases",
      origin: "user_stated",
      source_turn_id: "turn-2",
    },
  ]);
  assert.deepEqual(context.active_entries.assumptions, []);
  assert.deepEqual(context.active_entries.constraints, []);
  assert.deepEqual(
    Object.values(context.active_entries).flat().map((entry) => entry.id).sort(),
    ["criteria-1", "objective-1", "objective-2", "problem-1"]
  );
});

test("compact context includes working memory, version, recent changes, and undo availability", () => {
  const workspace = createPopulatedWorkspace();

  const context = buildCompactWorkspaceContext(workspace);
  const snapshot = getWorkspaceSnapshot(workspace);

  assert.equal(context.version, snapshot.version);
  assert.deepEqual(context.working_memory, snapshot.working_memory);
  assert.equal(context.can_undo, true);
  assert.deepEqual(context.recent_changes, snapshot.operation_log);
});

test("compact context caps recent changes to the last eight operation log entries", () => {
  const workspace = createReasoningWorkspace();
  for (let index = 1; index <= 10; index += 1) {
    applyWorkspaceOperations(workspace, [{
      type: "update_working_memory",
      summary: `Summary ${index}`,
    }]);
  }

  const context = buildCompactWorkspaceContext(workspace);

  assert.equal(context.recent_changes.length, 8);
  assert.deepEqual(
    context.recent_changes.map((change) => change.version),
    [3, 4, 5, 6, 7, 8, 9, 10]
  );
});

test("realtime briefing omits removed and corrected entries", () => {
  const workspace = createPopulatedWorkspace();

  const briefing = buildRealtimeWorkspaceBriefing(workspace);

  assert.match(briefing, /Deployment strategy/);
  assert.match(briefing, /Choosing a deployment strategy/);
  assert.match(briefing, /Reduce release risk/);
  assert.match(briefing, /Prefer weekday releases/);
  assert.match(briefing, /\[AI-inferred, source turn-1\] Operational confidence/);
  assert.doesNotMatch(briefing, /Existing CI is stable/);
  assert.doesNotMatch(briefing, /Must avoid weekend releases/);
});

test("realtime briefing includes provenance labels and delegation instructions", () => {
  const workspace = createPopulatedWorkspace();

  const briefing = buildRealtimeWorkspaceBriefing(workspace);

  assert.match(briefing, /user-stated/i);
  assert.match(briefing, /AI-inferred/i);
  assert.match(briefing, /use this briefing for continuity/i);
  assert.match(briefing, /delegate substantive reasoning/i);
  assert.match(briefing, /committed-memory changes/i);
});

test("compact context and realtime briefing are deterministic for the same workspace snapshot", () => {
  const workspace = createPopulatedWorkspace();

  assert.deepEqual(
    buildCompactWorkspaceContext(workspace),
    buildCompactWorkspaceContext(workspace)
  );
  assert.equal(
    buildRealtimeWorkspaceBriefing(workspace),
    buildRealtimeWorkspaceBriefing(workspace)
  );
});
