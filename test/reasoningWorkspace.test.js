const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CATEGORIES,
  createReasoningWorkspace,
  applyWorkspaceOperations,
  undoLastWorkspaceCheckpoint,
  getWorkspaceSnapshot,
} = require("../lib/reasoningWorkspace");

test("creates an empty two-layer workspace", () => {
  const workspace = createReasoningWorkspace();
  const snapshot = getWorkspaceSnapshot(workspace);

  assert.deepEqual(Array.from(CATEGORIES), [
    "problem",
    "objectives",
    "constraints",
    "assumptions",
    "options",
    "criteria",
    "decisions",
    "open_questions",
  ]);
  assert.equal(snapshot.version, 0);
  assert.deepEqual(snapshot.working_memory, {
    summary: "",
    current_topic: "",
    candidate_options: [],
    provisional_observations: [],
    unresolved_references: [],
    board_focus: null,
    updated_at: null,
  });
  assert.deepEqual(snapshot.entries, []);
  assert.deepEqual(snapshot.operation_log, []);
  assert.deepEqual(workspace.undo_stack, []);
  assert.equal(snapshot.can_undo, false);
});

test("records working memory and committed entries with provenance", () => {
  const workspace = createReasoningWorkspace();
  const result = applyWorkspaceOperations(workspace, [
    {
      type: "update_working_memory",
      summary: "Comparing two platform options",
      current_topic: "Platform choice",
      candidate_options: ["Option A", "Option B"],
    },
    {
      type: "add_entry",
      id: "entry-cost",
      category: "criteria",
      content: "Cost predictability",
      origin: "ai_inferred",
      source_turn_id: "turn-1",
    },
  ], { source: "coordinator", turn_id: "turn-1" });

  assert.equal(result.ok, true);
  assert.match(result.undo_checkpoint_id, /^workspace-checkpoint-/);
  assert.equal(result.workspace_state.version, 2);
  assert.equal(result.workspace_state.working_memory.current_topic, "Platform choice");
  assert.equal(result.workspace_state.working_memory.summary, "Comparing two platform options");
  assert.ok(result.workspace_state.working_memory.updated_at);
  assert.deepEqual(result.workspace_state.entries[0], {
    id: "entry-cost",
    category: "criteria",
    content: "Cost predictability",
    origin: "ai_inferred",
    source_turn_id: "turn-1",
    status: "active",
    supersedes_id: null,
  });
  assert.equal(workspace.operation_log.length, 2);
  assert.deepEqual(workspace.operation_log.map((operation) => operation.version), [1, 2]);
  assert.equal(workspace.operation_log[0].source, "coordinator");
  assert.equal(workspace.operation_log[0].turn_id, "turn-1");
  assert.equal(workspace.operation_log[0].checkpoint_id, result.undo_checkpoint_id);
  assert.ok(workspace.operation_log[0].applied_at);
});

test("correction preserves the old entry and creates an active replacement", () => {
  const workspace = createReasoningWorkspace();
  applyWorkspaceOperations(workspace, [
    {
      type: "add_entry",
      id: "entry-a",
      category: "constraints",
      content: "Must be cloud hosted",
      origin: "ai_inferred",
      source_turn_id: "turn-1",
    },
  ]);

  applyWorkspaceOperations(workspace, [
    {
      type: "correct_entry",
      id: "entry-a",
      replacement_id: "entry-b",
      category: "objectives",
      content: "Cloud hosting is preferred",
      origin: "user_stated",
      source_turn_id: "turn-2",
    },
  ]);

  const snapshot = getWorkspaceSnapshot(workspace);
  assert.equal(snapshot.entries.find((entry) => entry.id === "entry-a").status, "corrected");
  assert.deepEqual(snapshot.entries.find((entry) => entry.id === "entry-b"), {
    id: "entry-b",
    category: "objectives",
    content: "Cloud hosting is preferred",
    origin: "user_stated",
    source_turn_id: "turn-2",
    status: "active",
    supersedes_id: "entry-a",
  });
});

test("supersedes active content and removes active content while preserving entries", () => {
  const workspace = createReasoningWorkspace();
  applyWorkspaceOperations(workspace, [
    {
      type: "add_entry",
      id: "option-a",
      category: "options",
      content: "Option A",
      origin: "user_stated",
      source_turn_id: "turn-1",
    },
    {
      type: "add_entry",
      id: "question-a",
      category: "open_questions",
      content: "Confirm budget",
      origin: "ai_inferred",
      source_turn_id: "turn-1",
    },
  ]);

  applyWorkspaceOperations(workspace, [
    {
      type: "supersede_entry",
      id: "option-a",
      replacement_id: "option-b",
      category: "options",
      content: "Option B",
      origin: "user_stated",
      source_turn_id: "turn-2",
    },
    {
      type: "remove_entry",
      id: "question-a",
      category: "open_questions",
      content: "Confirm budget",
      origin: "user_stated",
      source_turn_id: "turn-2",
    },
  ]);

  const snapshot = getWorkspaceSnapshot(workspace);
  assert.equal(snapshot.entries.find((entry) => entry.id === "option-a").status, "superseded");
  assert.equal(snapshot.entries.find((entry) => entry.id === "option-b").status, "active");
  assert.equal(snapshot.entries.find((entry) => entry.id === "option-b").supersedes_id, "option-a");
  assert.equal(snapshot.entries.find((entry) => entry.id === "question-a").status, "removed");
});

test("undo restores working memory and authoritative entries without erasing log history", () => {
  const workspace = createReasoningWorkspace();
  applyWorkspaceOperations(workspace, [
    {
      type: "update_working_memory",
      summary: "Original summary",
      current_topic: "Original topic",
    },
    {
      type: "add_entry",
      id: "entry-decision",
      category: "decisions",
      content: "Choose option A",
      origin: "ai_inferred",
      source_turn_id: "turn-1",
    },
  ]);
  applyWorkspaceOperations(workspace, [
    { type: "update_working_memory", summary: "Changed summary" },
    {
      type: "remove_entry",
      id: "entry-decision",
      category: "decisions",
      content: "Choose option A",
      origin: "user_stated",
      source_turn_id: "turn-2",
    },
  ]);

  const logLengthBeforeUndo = workspace.operation_log.length;
  const undo = undoLastWorkspaceCheckpoint(workspace);

  assert.equal(undo.ok, true);
  assert.equal(undo.workspace_state.working_memory.summary, "Original summary");
  assert.equal(undo.workspace_state.entries[0].status, "active");
  assert.equal(workspace.operation_log.length, logLengthBeforeUndo + 1);
  assert.equal(workspace.operation_log.at(-1).type, "undo");
  assert.equal(undo.undone_checkpoint_id, workspace.operation_log.at(-1).checkpoint_id);
});

test("undo reports a snapshot when no checkpoint exists", () => {
  const workspace = createReasoningWorkspace();
  const result = undoLastWorkspaceCheckpoint(workspace);

  assert.equal(result.ok, false);
  assert.equal(result.workspace_state.version, 0);
  assert.equal(result.workspace_state.can_undo, false);
});

test("rejects invalid operation batches and unsupported entry categories", () => {
  const workspace = createReasoningWorkspace();

  assert.throws(
    () => applyWorkspaceOperations(workspace, []),
    /non-empty array/
  );
  assert.throws(
    () => applyWorkspaceOperations(workspace, [{ type: "freeform_memory" }]),
    /Unsupported workspace operation/
  );
  assert.throws(
    () => applyWorkspaceOperations(workspace, [{
      type: "add_entry",
      id: "entry-invalid",
      category: "risks",
      content: "Unrecognized category",
      origin: "ai_inferred",
    }]),
    /Unsupported workspace category/
  );
});

test("invalid operation in a batch leaves workspace completely unchanged", () => {
  const workspace = createReasoningWorkspace();
  const before = getWorkspaceSnapshot(workspace);

  assert.throws(
    () => applyWorkspaceOperations(workspace, [
      {
        type: "add_entry",
        id: "entry-valid",
        category: "problem",
        content: "This addition must not survive",
        origin: "user_stated",
        source_turn_id: "turn-1",
      },
      {
        type: "correct_entry",
        id: "missing-entry",
        replacement_id: "entry-replacement",
        category: "problem",
        content: "Invalid correction",
        origin: "user_stated",
        source_turn_id: "turn-1",
      },
    ], { source: "coordinator", turn_id: "turn-1" }),
    /Active workspace entry not found/
  );

  assert.deepEqual(getWorkspaceSnapshot(workspace), before);
  assert.deepEqual(workspace.undo_stack, []);
});

test("rejects invalid remove entry fields without changing the active entry", () => {
  const workspace = createReasoningWorkspace();
  applyWorkspaceOperations(workspace, [{
    type: "add_entry",
    id: "entry-to-keep",
    category: "constraints",
    content: "Keep this active",
    origin: "user_stated",
    source_turn_id: "turn-1",
  }]);

  const invalidRemovals = [
    [{
      type: "remove_entry",
      id: "entry-to-keep",
      category: "risks",
      content: "Keep this active",
      origin: "user_stated",
    }, /Unsupported workspace category/],
    [{
      type: "remove_entry",
      id: "entry-to-keep",
      category: "constraints",
      content: "Keep this active",
      origin: "imported",
    }, /Unsupported workspace origin/],
    [{
      type: "remove_entry",
      id: "entry-to-keep",
      category: "constraints",
      content: "  ",
      origin: "user_stated",
    }, /Workspace entry content is required/],
  ];

  invalidRemovals.forEach(([operation, expectedError]) => {
    const before = getWorkspaceSnapshot(workspace);
    assert.throws(() => applyWorkspaceOperations(workspace, [operation]), expectedError);
    assert.deepEqual(getWorkspaceSnapshot(workspace), before);
    assert.equal(getWorkspaceSnapshot(workspace).entries[0].status, "active");
  });
});
