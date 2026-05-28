const CATEGORIES = Object.freeze([
  "problem",
  "objectives",
  "constraints",
  "assumptions",
  "options",
  "criteria",
  "decisions",
  "open_questions",
]);
const CATEGORY_SET = new Set(CATEGORIES);

const ORIGINS = new Set(["user_stated", "ai_inferred"]);
const OPERATION_TYPES = new Set([
  "update_working_memory",
  "add_entry",
  "correct_entry",
  "supersede_entry",
  "remove_entry",
]);
const COMMITTED_OPERATION_TYPES = new Set([
  "add_entry",
  "correct_entry",
  "supersede_entry",
  "remove_entry",
]);
const ARRAY_MEMORY_FIELDS = new Set([
  "candidate_options",
  "provisional_observations",
  "unresolved_references",
]);
const TEXT_MEMORY_FIELDS = new Set(["summary", "current_topic"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createReasoningWorkspace() {
  return {
    version: 0,
    working_memory: {
      summary: "",
      current_topic: "",
      candidate_options: [],
      provisional_observations: [],
      unresolved_references: [],
      board_focus: null,
      updated_at: null,
    },
    entries: [],
    operation_log: [],
    undo_stack: [],
  };
}

function authoritativeSnapshot(workspace) {
  return {
    entries: clone(workspace.entries),
  };
}

function validateOperationType(operation) {
  if (!operation || !OPERATION_TYPES.has(operation.type)) {
    throw new Error(`Unsupported workspace operation: ${operation?.type || "unknown"}`);
  }
}

function validateEntryFields(operation) {
  if (!CATEGORY_SET.has(operation.category)) {
    throw new Error(`Unsupported workspace category: ${operation.category}`);
  }
  if (!ORIGINS.has(operation.origin)) {
    throw new Error(`Unsupported workspace origin: ${operation.origin}`);
  }
  if (typeof operation.content !== "string" || !operation.content.trim()) {
    throw new Error("Workspace entry content is required.");
  }
}

function validateTargetId(operation) {
  if (typeof operation.id !== "string" || !operation.id.trim()) {
    throw new Error("Workspace entry id is required.");
  }
}

function validateReplacementId(operation) {
  if (typeof operation.replacement_id !== "string" || !operation.replacement_id.trim()) {
    throw new Error("Workspace replacement_id is required.");
  }
}

function ensureUniqueEntryId(workspace, id) {
  if (workspace.entries.some((entry) => entry.id === id)) {
    throw new Error(`Workspace entry id already exists: ${id}`);
  }
}

function resolveTurnId(operation, metadata) {
  const operationTurnId = operation.source_turn_id || null;
  const metadataTurnId = metadata.turn_id || null;
  if (operationTurnId && metadataTurnId && operationTurnId !== metadataTurnId) {
    throw new Error("Conflicting workspace turn ids.");
  }
  return metadataTurnId || operationTurnId || null;
}

function applyWorkingMemoryUpdate(workspace, operation, appliedAt) {
  const changes = {};

  TEXT_MEMORY_FIELDS.forEach((field) => {
    if (field in operation) {
      if (typeof operation[field] !== "string") {
        throw new Error(`Working memory ${field} must be a string.`);
      }
      changes[field] = operation[field];
    }
  });
  ARRAY_MEMORY_FIELDS.forEach((field) => {
    if (field in operation) {
      if (!Array.isArray(operation[field])) {
        throw new Error(`Working memory ${field} must be an array.`);
      }
      changes[field] = clone(operation[field]);
    }
  });
  if ("board_focus" in operation) {
    if (operation.board_focus !== null && typeof operation.board_focus !== "string") {
      throw new Error("Working memory board_focus must be a string or null.");
    }
    changes.board_focus = operation.board_focus;
  }

  workspace.working_memory = {
    ...workspace.working_memory,
    ...changes,
    updated_at: appliedAt,
  };
}

function createEntry(operation, id, turnId) {
  return {
    id,
    category: operation.category,
    content: operation.content.trim(),
    origin: operation.origin,
    source_turn_id: turnId,
    status: "active",
    supersedes_id: null,
  };
}

function findActiveEntry(workspace, operation) {
  validateTargetId(operation);
  const entry = workspace.entries.find((candidate) => candidate.id === operation.id && candidate.status === "active");
  if (!entry) {
    throw new Error(`Active workspace entry not found: ${operation.id}`);
  }
  return entry;
}

function applyOperation(workspace, operation, turnId, appliedAt) {
  validateOperationType(operation);

  if (operation.type === "update_working_memory") {
    applyWorkingMemoryUpdate(workspace, operation, appliedAt);
    return;
  }

  if (operation.type === "add_entry") {
    validateEntryFields(operation);
    validateTargetId(operation);
    const id = operation.id;
    ensureUniqueEntryId(workspace, id);
    workspace.entries.push(createEntry(operation, id, turnId));
    return;
  }

  const priorEntry = findActiveEntry(workspace, operation);
  if (operation.type === "remove_entry") {
    validateEntryFields(operation);
    if (priorEntry.category !== operation.category || priorEntry.content !== operation.content.trim()) {
      throw new Error("Removal must identify the active workspace entry.");
    }
    priorEntry.status = "removed";
    return;
  }

  validateEntryFields(operation);
  validateReplacementId(operation);
  const replacementId = operation.replacement_id;
  ensureUniqueEntryId(workspace, replacementId);
  priorEntry.status = operation.type === "correct_entry" ? "corrected" : "superseded";
  const replacement = createEntry(operation, replacementId, turnId);
  replacement.supersedes_id = priorEntry.id;
  workspace.entries.push(replacement);
}

function applyWorkspaceOperations(workspace, operations, metadata = {}) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("workspace_operations must be a non-empty array");
  }

  const checkpointId = makeId("workspace-checkpoint");
  const before = authoritativeSnapshot(workspace);
  const draft = clone(workspace);
  const isUndoableReasoningBatch = operations.some((operation) => COMMITTED_OPERATION_TYPES.has(operation.type));

  operations.forEach((operation) => {
    const appliedAt = new Date().toISOString();
    const turnId = resolveTurnId(operation, metadata);
    applyOperation(draft, operation, turnId, appliedAt);
    draft.version += 1;
    draft.operation_log.push({
      ...clone(operation),
      source: metadata.source || "system",
      turn_id: turnId,
      checkpoint_id: checkpointId,
      version: draft.version,
      applied_at: appliedAt,
    });
  });

  if (isUndoableReasoningBatch) {
    draft.undo_stack.push({
      checkpoint_id: checkpointId,
      snapshot: before,
      operation_count: operations.length,
    });
  }

  workspace.version = draft.version;
  workspace.working_memory = draft.working_memory;
  workspace.entries = draft.entries;
  workspace.operation_log = draft.operation_log;
  workspace.undo_stack = draft.undo_stack;

  return {
    ok: true,
    workspace_state: getWorkspaceSnapshot(workspace),
    undo_checkpoint_id: isUndoableReasoningBatch ? checkpointId : null,
  };
}

function undoLastWorkspaceCheckpoint(workspace) {
  const checkpoint = workspace.undo_stack.pop();
  if (!checkpoint) {
    return {
      ok: false,
      error: "Nothing to undo.",
      workspace_state: getWorkspaceSnapshot(workspace),
    };
  }

  workspace.entries = clone(checkpoint.snapshot.entries);
  workspace.version += 1;
  workspace.operation_log.push({
    type: "undo",
    source: "user",
    turn_id: null,
    checkpoint_id: checkpoint.checkpoint_id,
    version: workspace.version,
    applied_at: new Date().toISOString(),
  });

  return {
    ok: true,
    undone_checkpoint_id: checkpoint.checkpoint_id,
    workspace_state: getWorkspaceSnapshot(workspace),
  };
}

function getWorkspaceSnapshot(workspace) {
  return {
    version: workspace.version,
    working_memory: clone(workspace.working_memory),
    entries: clone(workspace.entries),
    operation_log: clone(workspace.operation_log),
    can_undo: workspace.undo_stack.length > 0,
  };
}

module.exports = {
  CATEGORIES,
  createReasoningWorkspace,
  applyWorkspaceOperations,
  undoLastWorkspaceCheckpoint,
  getWorkspaceSnapshot,
};
