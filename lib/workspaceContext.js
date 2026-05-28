const {
  CATEGORIES,
  getWorkspaceSnapshot,
} = require("./reasoningWorkspace");

const CATEGORY_LABELS = Object.freeze({
  problem: "Problem",
  objectives: "Objectives",
  constraints: "Constraints",
  assumptions: "Assumptions",
  options: "Options",
  criteria: "Criteria",
  decisions: "Decisions",
  open_questions: "Open questions",
});

const MAX_ACTIVE_ENTRIES_PER_CATEGORY = 8;
const MAX_WORKING_MEMORY_ITEMS = 8;
const MAX_FIELD_LENGTH = 240;
const MAX_RECENT_CHANGE_SNIPPET_LENGTH = 160;
const TEXT_MEMORY_FIELDS = Object.freeze(["summary", "current_topic", "board_focus"]);
const ARRAY_MEMORY_FIELDS = Object.freeze([
  "candidate_options",
  "provisional_observations",
  "unresolved_references",
]);

function createEmptyActiveEntries() {
  return Object.fromEntries(CATEGORIES.map((category) => [category, []]));
}

function normalizeText(value, maxLength = MAX_FIELD_LENGTH) {
  if (value === null || value === undefined) {
    return value;
  }
  const normalized = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function dataQuote(value) {
  const normalized = normalizeText(value);
  return `data(${JSON.stringify(normalized || "Not set")})`;
}

function compactActiveEntry(entry) {
  return {
    id: normalizeText(entry.id),
    content: normalizeText(entry.content),
    origin: normalizeText(entry.origin),
    source_turn_id: normalizeText(entry.source_turn_id),
  };
}

function compactWorkingMemory(workingMemory) {
  const compacted = {};

  TEXT_MEMORY_FIELDS.forEach((field) => {
    compacted[field] = normalizeText(workingMemory[field]);
  });
  ARRAY_MEMORY_FIELDS.forEach((field) => {
    compacted[field] = (workingMemory[field] || [])
      .slice(0, MAX_WORKING_MEMORY_ITEMS)
      .map((item) => normalizeText(item));
  });
  compacted.updated_at = normalizeText(workingMemory.updated_at);

  return compacted;
}

function changeSnippet(change) {
  if (typeof change.content === "string") {
    return normalizeText(change.content, MAX_RECENT_CHANGE_SNIPPET_LENGTH);
  }
  if (typeof change.summary === "string") {
    return normalizeText(change.summary, MAX_RECENT_CHANGE_SNIPPET_LENGTH);
  }
  return undefined;
}

function compactRecentChange(change) {
  const compacted = {
    type: normalizeText(change.type),
    version: change.version,
  };
  const category = normalizeText(change.category);
  const id = normalizeText(change.replacement_id || change.id);
  const snippet = changeSnippet(change);

  if (category) {
    compacted.category = category;
  }
  if (id) {
    compacted.id = id;
  }
  if (snippet) {
    compacted.snippet = snippet;
  }

  return compacted;
}

function buildCompactWorkspaceContext(workspace) {
  const snapshot = getWorkspaceSnapshot(workspace);
  const activeEntries = createEmptyActiveEntries();

  snapshot.entries
    .filter((entry) => entry.status === "active")
    .forEach((entry) => {
      if (Object.prototype.hasOwnProperty.call(activeEntries, entry.category)) {
        if (activeEntries[entry.category].length < MAX_ACTIVE_ENTRIES_PER_CATEGORY) {
          activeEntries[entry.category].push(compactActiveEntry(entry));
        }
      }
    });

  return {
    version: snapshot.version,
    working_memory: compactWorkingMemory(snapshot.working_memory),
    active_entries: activeEntries,
    recent_changes: snapshot.operation_log.slice(-8).map(compactRecentChange),
    can_undo: snapshot.can_undo,
  };
}

function provenanceLabel(origin) {
  if (origin === "user_stated") {
    return "user-stated";
  }
  if (origin === "ai_inferred") {
    return "AI-inferred";
  }
  return origin || "unknown";
}

function appendWorkingMemoryLines(lines, workingMemory) {
  lines.push(`Current topic: ${dataQuote(workingMemory.current_topic)}`);
  lines.push(`Summary: ${dataQuote(workingMemory.summary)}`);

  if (workingMemory.candidate_options.length > 0) {
    lines.push(`Candidate options: ${workingMemory.candidate_options.map(dataQuote).join("; ")}`);
  }
  if (workingMemory.provisional_observations.length > 0) {
    lines.push(`Provisional observations: ${workingMemory.provisional_observations.map(dataQuote).join("; ")}`);
  }
  if (workingMemory.unresolved_references.length > 0) {
    lines.push(`Unresolved references: ${workingMemory.unresolved_references.map(dataQuote).join("; ")}`);
  }
}

function appendActiveEntryLines(lines, activeEntries) {
  const populatedCategories = CATEGORIES.filter((category) => activeEntries[category].length > 0);

  lines.push("Active committed entries:");
  if (populatedCategories.length === 0) {
    lines.push("- None yet.");
    return;
  }

  populatedCategories.forEach((category) => {
    lines.push(`${CATEGORY_LABELS[category]}:`);
    activeEntries[category].forEach((entry) => {
      const turn = entry.source_turn_id ? `, source ${dataQuote(entry.source_turn_id)}` : "";
      lines.push(`- [${provenanceLabel(entry.origin)}${turn}] ${dataQuote(entry.content)}`);
    });
  });
}

function buildRealtimeWorkspaceBriefing(workspace) {
  const context = buildCompactWorkspaceContext(workspace);
  const lines = [
    "Shared reasoning workspace briefing.",
    `Workspace version: ${context.version}`,
    "Use this briefing for continuity. Delegate substantive reasoning and committed-memory changes to the coordinator/tooling path; do not silently change committed memory while speaking.",
    "Provenance labels distinguish user-stated facts from AI-inferred items.",
  ];

  appendWorkingMemoryLines(lines, context.working_memory);
  appendActiveEntryLines(lines, context.active_entries);

  lines.push(`Reasoning undo available: ${context.can_undo ? "yes" : "no"}`);

  return lines.join("\n");
}

module.exports = {
  buildCompactWorkspaceContext,
  buildRealtimeWorkspaceBriefing,
};
