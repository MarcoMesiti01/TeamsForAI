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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createEmptyActiveEntries() {
  return Object.fromEntries(CATEGORIES.map((category) => [category, []]));
}

function compactActiveEntry(entry) {
  return {
    id: entry.id,
    content: entry.content,
    origin: entry.origin,
    source_turn_id: entry.source_turn_id,
  };
}

function buildCompactWorkspaceContext(workspace) {
  const snapshot = getWorkspaceSnapshot(workspace);
  const activeEntries = createEmptyActiveEntries();

  snapshot.entries
    .filter((entry) => entry.status === "active")
    .forEach((entry) => {
      if (Object.prototype.hasOwnProperty.call(activeEntries, entry.category)) {
        activeEntries[entry.category].push(compactActiveEntry(entry));
      }
    });

  return {
    version: snapshot.version,
    working_memory: clone(snapshot.working_memory),
    active_entries: activeEntries,
    recent_changes: snapshot.operation_log.slice(-8),
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
  lines.push(`Current topic: ${workingMemory.current_topic || "Not set"}`);
  lines.push(`Summary: ${workingMemory.summary || "Not set"}`);

  if (workingMemory.candidate_options.length > 0) {
    lines.push(`Candidate options: ${workingMemory.candidate_options.join("; ")}`);
  }
  if (workingMemory.provisional_observations.length > 0) {
    lines.push(`Provisional observations: ${workingMemory.provisional_observations.join("; ")}`);
  }
  if (workingMemory.unresolved_references.length > 0) {
    lines.push(`Unresolved references: ${workingMemory.unresolved_references.join("; ")}`);
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
      const turn = entry.source_turn_id ? `, source ${entry.source_turn_id}` : "";
      lines.push(`- [${provenanceLabel(entry.origin)}${turn}] ${entry.content}`);
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
