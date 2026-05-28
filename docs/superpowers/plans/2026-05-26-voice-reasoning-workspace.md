# Voice-First Reasoning Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each live voice session use a two-layer shared reasoning workspace so spoken follow-ups, authoritative memory, and the visual board stay aligned and correctable.

**Architecture:** Add an in-memory reasoning workspace beside the existing board state, with deterministic workspace operations and compact voice briefings. A new turn coordinator processes substantive voice turns by extracting workspace changes, applying validated committed memory, generating grounded reasoning, and queueing board synchronization; the browser displays the committed ledger and refreshes the realtime model's instructions through documented `session.update` events.

**Tech Stack:** Node.js CommonJS, Express, browser WebRTC/DataChannel, OpenAI Realtime API and Responses API, vanilla HTML/CSS/JavaScript, Node built-in test runner.

---

## Goal

Implement milestone 1 from `docs/superpowers/specs/2026-05-26-voice-reasoning-workspace-design.md`: a voice-first, session-only reasoning workspace with working memory, committed memory, correction/undo, workspace-grounded responses, and synchronized ledger/board presentation.

## Constraints

- Voice is the required acceptance path; typed input is not a substitute for delivery.
- State is intentionally in memory for this milestone and is isolated per `client_session_id`.
- The realtime model remains an independent conversational speaker for trivial interaction.
- Substantive turns must use shared workspace context and leave visible state transitions.
- AI-inferred committed entries are permitted automatically, but they require provenance and reversible history.
- Existing typed board operations and board undo remain valid; reasoning undo is separate.
- Use structured model output for workspace operations and validate it in application code.
- Keep current `/v1/realtime/calls` WebRTC transport. Official Realtime documentation permits updating session `instructions` after connection using a `session.update` client event.

## File Structure

**New backend modules**

- `lib/reasoningWorkspace.js`: deterministic two-layer state model, operation validation/application, snapshots, and reasoning undo.
- `lib/workspaceContext.js`: compact snapshots and briefing text for models and realtime session instructions.
- `lib/workspaceUpdateService.js`: structured extraction of working-memory and committed-memory changes from a substantive utterance.
- `lib/workspaceResponseService.js`: substantive response generation grounded in both workspace layers.
- `lib/turnCoordinatorService.js`: orchestration of memory update, response, and visual synchronization request.

**Modified backend modules**

- `lib/whiteboardCommandService.js`: carry workspace context and synchronization reason into whiteboard commands.
- `lib/whiteboardPlannerService.js`: use workspace state in visual plans and attach memory/provenance metadata to relevant nodes.
- `lib/whiteboardJobService.js`: expose stale/pending synchronization results without affecting authoritative workspace state.
- `lib/boardState.js`: retain optional `workspace_entry_id`, `memory_status`, and `origin` node metadata.
- `server.js`: initialize session workspaces, expose coordinated voice tools and workspace endpoints, and return updated realtime briefings.

**Modified frontend files**

- `public/index.html`: add workspace ledger and separate reasoning undo control.
- `public/style.css`: layout and state markers for ledger and tentative/committed board content.
- `public/app.js`: render workspace snapshots, poll/update synchronization state, invoke reasoning undo, and send realtime `session.update` briefings.

**Tests**

- Create: `test/reasoningWorkspace.test.js`
- Create: `test/workspaceContext.test.js`
- Create: `test/workspaceUpdateService.test.js`
- Create: `test/workspaceResponseService.test.js`
- Create: `test/turnCoordinatorService.test.js`
- Create: `test/serverWorkspaceFlow.test.js`
- Modify: `test/run.js`
- Modify: `test/whiteboardCommandService.test.js`
- Modify: `test/whiteboardPlannerService.test.js`
- Modify: `test/whiteboardJobService.test.js`
- Modify: `test/boardState.test.js`
- Modify: `test/frontendLayout.test.js`

## Execution Order

### Task 1: Implement Deterministic Reasoning Workspace State

**Files:**
- Create: `lib/reasoningWorkspace.js`
- Create: `test/reasoningWorkspace.test.js`
- Modify: `test/run.js`

**Corrected state contract:**

- `add_entry.id` and replacement IDs for `correct_entry` / `supersede_entry` are required non-empty strings supplied by the caller. Only internal checkpoint IDs are generated.
- `CATEGORIES` exports an immutable value collection for consumers; category validation uses an internal set that callers cannot mutate. Committed entry content must be a non-empty string and is never coerced from other values.
- Reasoning undo targets the most recent batch containing a committed-workspace mutation (`add_entry`, `correct_entry`, `supersede_entry`, or `remove_entry`). Working-memory-only batches update state and the log but do not occupy reasoning undo and return `undo_checkpoint_id: null`; operation-log records may still carry an internal checkpoint/correlation ID.
- Undo restores committed entries only; it leaves the current working-memory layer intact. Operation-log and public workspace versions remain strictly monotonic through undo and later operations.

- [ ] **Step 1: Register and write failing workspace state tests**

Append the test import to `test/run.js`:

```js
require("./reasoningWorkspace.test");
```

Create `test/reasoningWorkspace.test.js` with tests for creation, application, correction, removal, and undo:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createReasoningWorkspace,
  applyWorkspaceOperations,
  undoLastWorkspaceCheckpoint,
  getWorkspaceSnapshot,
} = require("../lib/reasoningWorkspace");

test("creates an empty two-layer workspace", () => {
  const workspace = createReasoningWorkspace();
  const snapshot = getWorkspaceSnapshot(workspace);

  assert.equal(snapshot.version, 0);
  assert.equal(snapshot.working_memory.current_topic, "");
  assert.deepEqual(snapshot.entries, []);
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

  assert.equal(result.workspace_state.entries[0].status, "active");
  assert.equal(result.workspace_state.entries[0].origin, "ai_inferred");
  assert.equal(result.workspace_state.working_memory.current_topic, "Platform choice");
  assert.equal(workspace.operation_log.length, 2);
});

test("correction preserves the old entry and creates an active replacement", () => {
  const workspace = createReasoningWorkspace();
  applyWorkspaceOperations(workspace, [
    { type: "add_entry", id: "entry-a", category: "constraints", content: "Must be cloud hosted", origin: "ai_inferred", source_turn_id: "turn-1" },
  ]);

  applyWorkspaceOperations(workspace, [
    { type: "correct_entry", id: "entry-a", replacement_id: "entry-b", category: "objectives", content: "Cloud hosting is preferred", origin: "user_stated", source_turn_id: "turn-2" },
  ]);

  const snapshot = getWorkspaceSnapshot(workspace);
  assert.equal(snapshot.entries.find((entry) => entry.id === "entry-a").status, "corrected");
  assert.equal(snapshot.entries.find((entry) => entry.id === "entry-b").status, "active");
  assert.equal(snapshot.entries.find((entry) => entry.id === "entry-b").supersedes_id, "entry-a");
});

test("undo restores authoritative entries while retaining current working memory", () => {
  const workspace = createReasoningWorkspace();
  applyWorkspaceOperations(workspace, [
    { type: "add_entry", id: "entry-decision", category: "decisions", content: "Choose option A", origin: "ai_inferred", source_turn_id: "turn-1" },
  ]);
  applyWorkspaceOperations(workspace, [
    { type: "update_working_memory", summary: "Continue comparing alternatives" },
  ]);

  const undo = undoLastWorkspaceCheckpoint(workspace);

  assert.equal(undo.ok, true);
  assert.equal(undo.workspace_state.entries.length, 0);
  assert.equal(undo.workspace_state.working_memory.summary, "Continue comparing alternatives");
  assert.equal(workspace.operation_log.at(-1).type, "undo");
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm.cmd test`

Expected: FAIL because `../lib/reasoningWorkspace` does not exist.

- [ ] **Step 3: Create the workspace state module**

Create `lib/reasoningWorkspace.js` with a small state machine and clone-based checkpoints:

```js
const CATEGORIES = Object.freeze([
  "problem", "objectives", "constraints", "assumptions",
  "options", "criteria", "decisions", "open_questions",
]);
const CATEGORY_SET = new Set(CATEGORIES);
const ORIGINS = new Set(["user_stated", "ai_inferred"]);
const OPERATION_TYPES = new Set([
  "update_working_memory", "add_entry", "correct_entry",
  "supersede_entry", "remove_entry",
]);
const COMMITTED_OPERATION_TYPES = new Set([
  "add_entry", "correct_entry", "supersede_entry", "remove_entry",
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function validateEntryOperation(operation) {
  if (!CATEGORY_SET.has(operation.category)) throw new Error(`Unsupported workspace category: ${operation.category}`);
  if (!ORIGINS.has(operation.origin)) throw new Error(`Unsupported workspace origin: ${operation.origin}`);
  if (typeof operation.content !== "string" || !operation.content.trim()) throw new Error("Workspace entry content is required.");
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function stateSnapshot(workspace) {
  return {
    entries: clone(workspace.entries),
  };
}

function applyOperation(workspace, operation) {
  if (operation.type === "update_working_memory") {
    workspace.working_memory = {
      ...workspace.working_memory,
      ...Object.fromEntries(Object.entries(operation).filter(([key]) => key !== "type")),
      updated_at: new Date().toISOString(),
    };
    return;
  }
  const entry = workspace.entries.find((candidate) => candidate.id === operation.id);
  if (operation.type === "add_entry") {
    if (typeof operation.id !== "string" || !operation.id.trim()) throw new Error("Workspace entry id is required.");
    workspace.entries.push({
      id: operation.id,
      category: operation.category,
      content: operation.content.trim(),
      origin: operation.origin,
      source_turn_id: operation.source_turn_id || null,
      status: "active",
      supersedes_id: null,
    });
    return;
  }
  if (!entry || entry.status !== "active") throw new Error(`Active workspace entry not found: ${operation.id}`);
  if (operation.type === "remove_entry") {
    entry.status = "removed";
    return;
  }
  if (typeof operation.replacement_id !== "string" || !operation.replacement_id.trim()) throw new Error("Workspace replacement_id is required.");
  entry.status = operation.type === "correct_entry" ? "corrected" : "superseded";
  workspace.entries.push({
    id: operation.replacement_id,
    category: operation.category,
    content: operation.content.trim(),
    origin: operation.origin,
    source_turn_id: operation.source_turn_id || null,
    status: "active",
    supersedes_id: entry.id,
  });
}

function applyWorkspaceOperations(workspace, operations = [], metadata = {}) {
  if (!Array.isArray(operations) || !operations.length) {
    throw new Error("workspace_operations must be a non-empty array");
  }
  operations.forEach((operation) => {
    if (!OPERATION_TYPES.has(operation?.type)) throw new Error(`Unsupported workspace operation: ${operation?.type || "unknown"}`);
    if (operation.type !== "update_working_memory") validateEntryOperation(operation);
  });
  const checkpointId = makeId("workspace-checkpoint");
  const before = stateSnapshot(workspace);
  const hasCommittedMutation = operations.some((operation) => COMMITTED_OPERATION_TYPES.has(operation.type));
  operations.forEach((operation) => {
    applyOperation(workspace, operation);
    workspace.version += 1;
    workspace.operation_log.push({
      ...clone(operation),
      source: metadata.source || "system",
      turn_id: metadata.turn_id || operation.source_turn_id || null,
      checkpoint_id: checkpointId,
      version: workspace.version,
      applied_at: new Date().toISOString(),
    });
  });
  if (hasCommittedMutation) {
    workspace.undo_stack.push({ checkpoint_id: checkpointId, snapshot: before });
  }
  return { ok: true, workspace_state: getWorkspaceSnapshot(workspace), undo_checkpoint_id: hasCommittedMutation ? checkpointId : null };
}

function undoLastWorkspaceCheckpoint(workspace) {
  const checkpoint = workspace.undo_stack.pop();
  if (!checkpoint) {
    return { ok: false, error: "Nothing to undo.", workspace_state: getWorkspaceSnapshot(workspace) };
  }
  workspace.entries = clone(checkpoint.snapshot.entries);
  workspace.version += 1;
  workspace.operation_log.push({
    type: "undo",
    checkpoint_id: checkpoint.checkpoint_id,
    source: "user",
    version: workspace.version,
    applied_at: new Date().toISOString(),
  });
  return { ok: true, undone_checkpoint_id: checkpoint.checkpoint_id, workspace_state: getWorkspaceSnapshot(workspace) };
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
  createReasoningWorkspace,
  applyWorkspaceOperations,
  undoLastWorkspaceCheckpoint,
  getWorkspaceSnapshot,
  CATEGORIES,
};
```

- [ ] **Step 4: Run tests to verify deterministic state behavior**

Run: `npm.cmd test`

Expected: PASS for the existing suite and the new workspace tests.

- [ ] **Step 5: Commit the state foundation**

```bash
git add lib/reasoningWorkspace.js test/reasoningWorkspace.test.js test/run.js
git commit -m "Add in-memory reasoning workspace state"
```

### Task 2: Build Compact Workspace Context And Realtime Briefings

**Files:**
- Create: `lib/workspaceContext.js`
- Create: `test/workspaceContext.test.js`
- Modify: `test/run.js`

- [ ] **Step 1: Write failing tests for structured context and briefing text**

Append `require("./workspaceContext.test");` to `test/run.js`, then create:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createReasoningWorkspace, applyWorkspaceOperations } = require("../lib/reasoningWorkspace");
const { buildCompactWorkspaceContext, buildRealtimeWorkspaceBriefing } = require("../lib/workspaceContext");

test("briefing includes active committed entries and omits removed entries", () => {
  const workspace = createReasoningWorkspace();
  applyWorkspaceOperations(workspace, [
    { type: "update_working_memory", summary: "Considering deployment options", current_topic: "Deployment" },
    { type: "add_entry", id: "goal-1", category: "objectives", content: "Reduce deployment risk", origin: "user_stated", source_turn_id: "turn-1" },
    { type: "add_entry", id: "assumption-1", category: "assumptions", content: "Existing CI is stable", origin: "ai_inferred", source_turn_id: "turn-1" },
  ]);
  applyWorkspaceOperations(workspace, [
    { type: "remove_entry", id: "assumption-1", category: "assumptions", content: "Existing CI is stable", origin: "user_stated", source_turn_id: "turn-2" },
  ]);

  const context = buildCompactWorkspaceContext(workspace);
  const briefing = buildRealtimeWorkspaceBriefing(workspace);

  assert.equal(context.active_entries.objectives[0].content, "Reduce deployment risk");
  assert.equal(context.active_entries.assumptions.length, 0);
  assert.match(briefing, /Reduce deployment risk/);
  assert.doesNotMatch(briefing, /Existing CI is stable/);
});
```

- [ ] **Step 2: Run tests to confirm the missing context module failure**

Run: `npm.cmd test`

Expected: FAIL because `../lib/workspaceContext` does not exist.

- [ ] **Step 3: Implement compact context and briefing generation**

Create `lib/workspaceContext.js`:

```js
const { getWorkspaceSnapshot, CATEGORIES } = require("./reasoningWorkspace");

function buildCompactWorkspaceContext(workspace) {
  const snapshot = getWorkspaceSnapshot(workspace);
  const activeEntries = Object.fromEntries(Array.from(CATEGORIES).map((category) => [category, []]));

  snapshot.entries
    .filter((entry) => entry.status === "active")
    .slice(-40)
    .forEach((entry) => {
      activeEntries[entry.category].push({
        id: entry.id,
        content: entry.content,
        origin: entry.origin,
      });
    });

  return {
    version: snapshot.version,
    working_memory: snapshot.working_memory,
    active_entries: activeEntries,
    recent_changes: snapshot.operation_log.slice(-8),
    can_undo: snapshot.can_undo,
  };
}

function buildRealtimeWorkspaceBriefing(workspace) {
  const context = buildCompactWorkspaceContext(workspace);
  const lines = [
    "Shared reasoning workspace briefing:",
    `Current topic: ${context.working_memory.current_topic || "not established"}`,
    `Working summary: ${context.working_memory.summary || "none"}`,
  ];
  Object.entries(context.active_entries).forEach(([category, entries]) => {
    if (entries.length) lines.push(`${category}: ${entries.map((entry) => entry.content).join("; ")}`);
  });
  lines.push("Use this context for conversational continuity. Delegate substantive reasoning or changes to committed memory.");
  return lines.join("\n");
}

module.exports = { buildCompactWorkspaceContext, buildRealtimeWorkspaceBriefing };
```

- [ ] **Step 4: Verify the context tests pass**

Run: `npm.cmd test`

Expected: PASS.

- [ ] **Step 5: Commit the workspace briefing layer**

```bash
git add lib/workspaceContext.js test/workspaceContext.test.js test/run.js
git commit -m "Add compact workspace briefings"
```

### Task 3: Extract Validated Workspace Changes From Spoken Turns

**Files:**
- Create: `lib/workspaceUpdateService.js`
- Create: `test/workspaceUpdateService.test.js`
- Modify: `test/run.js`

- [ ] **Step 1: Write failing service tests with an injected model provider**

Add `require("./workspaceUpdateService.test");` to `test/run.js` and create:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createReasoningWorkspace } = require("../lib/reasoningWorkspace");
const { proposeWorkspaceUpdate } = require("../lib/workspaceUpdateService");

test("normalizes model-proposed memory promotions with provenance", async () => {
  const result = await proposeWorkspaceUpdate({
    utterance: "Cost predictability matters, but we have not selected a provider.",
    turn_id: "turn-1",
  }, createReasoningWorkspace(), {
    updateProvider: async () => ({
      action: "update",
      spoken_commit_notice: "I will track cost predictability as a criterion.",
      operations: [
        { type: "update_working_memory", summary: "Comparing providers", current_topic: "Provider selection" },
        { type: "add_entry", id: "criterion-cost", category: "criteria", content: "Cost predictability", origin: "user_stated", source_turn_id: "turn-1" },
        { type: "add_entry", id: "question-choice", category: "open_questions", content: "Which provider should be selected?", origin: "ai_inferred", source_turn_id: "turn-1" },
      ],
    }),
  });

  assert.equal(result.action, "update");
  assert.equal(result.operations[1].origin, "user_stated");
  assert.match(result.spoken_commit_notice, /criterion/);
});

test("returns an undo action for a voice request to undo the last conclusion", async () => {
  const result = await proposeWorkspaceUpdate({
    utterance: "Undo the last conclusion.",
    turn_id: "turn-2",
  }, createReasoningWorkspace(), { apiKey: "" });

  assert.equal(result.action, "undo");
  assert.deepEqual(result.operations, []);
});

test("does not invent committed knowledge in the no-key fallback", async () => {
  const result = await proposeWorkspaceUpdate({
    utterance: "Let's examine this further.",
    turn_id: "turn-3",
  }, createReasoningWorkspace(), { apiKey: "" });

  assert.equal(result.action, "update");
  assert.deepEqual(result.operations.filter((operation) => operation.type === "add_entry"), []);
});
```

- [ ] **Step 2: Run tests to verify the update service is absent**

Run: `npm.cmd test`

Expected: FAIL because `../lib/workspaceUpdateService` does not exist.

- [ ] **Step 3: Implement structured workspace-update planning**

Create `lib/workspaceUpdateService.js`. Its public contract must be:

```js
const { MODEL_ROLES, selectModel } = require("./modelPolicy");
const { buildCompactWorkspaceContext } = require("./workspaceContext");

const ACTIONS = new Set(["update", "undo", "clarify"]);

async function proposeWorkspaceUpdate(payload, workspace, options = {}) {
  const utterance = String(payload.utterance || payload.user_goal || "").trim();
  if (!utterance) throw new Error("utterance is required");

  if (/\bundo\b.*\b(conclusion|reasoning|memory|decision)\b/i.test(utterance)) {
    return { action: "undo", operations: [], spoken_commit_notice: "I will undo the last reasoning update.", needs_clarification: "" };
  }

  const input = {
    turn_id: payload.turn_id,
    utterance,
    spoken_context: String(payload.spoken_context || ""),
    workspace: buildCompactWorkspaceContext(workspace),
  };
  if (options.updateProvider) {
    return normalizeUpdate(await options.updateProvider(input));
  }
  if (!(options.apiKey ?? process.env.OPENAI_API_KEY)) {
    return {
      action: "update",
      operations: [{ type: "update_working_memory", summary: utterance, current_topic: utterance.slice(0, 80) }],
      spoken_commit_notice: "",
      needs_clarification: "",
    };
  }
  return callWorkspaceUpdateModel(input, options);
}

function normalizeUpdate(raw = {}) {
  const action = ACTIONS.has(raw.action) ? raw.action : "clarify";
  const operations = Array.isArray(raw.operations) ? raw.operations : [];
  return {
    action,
    operations,
    spoken_commit_notice: String(raw.spoken_commit_notice || ""),
    needs_clarification: String(raw.needs_clarification || ""),
  };
}

async function callWorkspaceUpdateModel(input, options = {}) {
  const model = options.model || selectModel({
    role: MODEL_ROLES.orchestrator,
    complexity: "medium",
    latency_budget: "low",
    artifact_type: "reasoning_workspace",
  }).model;
  const response = await (options.fetchImpl || fetch)("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey ?? process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: "Extract structured workspace updates. Working memory is provisional. Add committed entries only for information useful in future reasoning. Mark directly expressed user facts as user_stated and derived content as ai_inferred. Return strict JSON." },
        { role: "user", content: JSON.stringify(input) },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "workspace_update",
          schema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["update", "undo", "clarify"] },
              operations: { type: "array", items: { type: "object", additionalProperties: true } },
              spoken_commit_notice: { type: "string" },
              needs_clarification: { type: "string" },
            },
            required: ["action", "operations", "spoken_commit_notice", "needs_clarification"],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Workspace update request failed");
  return normalizeUpdate(JSON.parse(data.output_text || "{}"));
}

module.exports = { proposeWorkspaceUpdate, normalizeUpdate };
```

- [ ] **Step 4: Run the service tests and full suite**

Run: `npm.cmd test`

Expected: PASS.

- [ ] **Step 5: Commit structured memory extraction**

```bash
git add lib/workspaceUpdateService.js test/workspaceUpdateService.test.js test/run.js
git commit -m "Add workspace update planning for voice turns"
```

### Task 4: Generate Substantive Responses From Shared Workspace Context

**Files:**
- Create: `lib/workspaceResponseService.js`
- Create: `test/workspaceResponseService.test.js`
- Modify: `test/run.js`

- [ ] **Step 1: Write failing grounded-response tests**

Add `require("./workspaceResponseService.test");` to `test/run.js` and create:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { generateWorkspaceResponse } = require("../lib/workspaceResponseService");

test("passes committed and working state to grounded reasoning", async () => {
  let seenInput;
  const response = await generateWorkspaceResponse({
    utterance: "How does this affect the choice?",
    workspace_context: {
      working_memory: { summary: "Comparing hosting options" },
      active_entries: { criteria: [{ content: "Cost predictability", origin: "user_stated" }] },
    },
  }, {
    responseProvider: async (input) => {
      seenInput = input;
      return {
        spoken_summary: "Cost predictability now favors the option with stable operating expense.",
        full_response: "Use the cost criterion while preserving unresolved technical questions.",
        reasoning_summary: "Applied the committed criterion to the follow-up.",
        uncertainties: ["Performance requirements remain open."],
        next_examination: "Clarify expected workloads.",
      };
    },
  });

  assert.match(JSON.stringify(seenInput.workspace_context), /Cost predictability/);
  assert.match(response.spoken_summary, /stable operating expense/);
  assert.deepEqual(response.uncertainties, ["Performance requirements remain open."]);
});
```

- [ ] **Step 2: Run the suite and observe the missing response service**

Run: `npm.cmd test`

Expected: FAIL because `../lib/workspaceResponseService` does not exist.

- [ ] **Step 3: Create the workspace response service**

Create `lib/workspaceResponseService.js` with this contract:

```js
const { MODEL_ROLES, selectModel } = require("./modelPolicy");

function normalizeResponse(output = {}) {
  return {
    spoken_summary: String(output.spoken_summary || ""),
    full_response: String(output.full_response || ""),
    reasoning_summary: String(output.reasoning_summary || ""),
    uncertainties: Array.isArray(output.uncertainties) ? output.uncertainties.map(String) : [],
    next_examination: String(output.next_examination || ""),
  };
}

async function generateWorkspaceResponse(input, options = {}) {
  if (options.responseProvider) return normalizeResponse(await options.responseProvider(input));
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return normalizeResponse({
      spoken_summary: "I captured the current reasoning context, but deeper analysis requires an API connection.",
      full_response: "Workspace state was updated; grounded reasoning is unavailable without an API key.",
      reasoning_summary: "No model response was generated.",
    });
  }
  const model = options.model || selectModel({
    role: MODEL_ROLES.brain_reasoner,
    complexity: "high",
    latency_budget: "relaxed",
    artifact_type: "reasoning_workspace",
  }).model;
  const response = await (options.fetchImpl || fetch)("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: "Reason from the shared workspace. Treat active committed entries as ground truth for this session, explicitly state uncertainty, do not invent a decision, and keep spoken_summary voice-ready." },
        { role: "user", content: JSON.stringify(input) },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "workspace_reasoning_response",
          schema: {
            type: "object",
            properties: {
              spoken_summary: { type: "string" },
              full_response: { type: "string" },
              reasoning_summary: { type: "string" },
              uncertainties: { type: "array", items: { type: "string" } },
              next_examination: { type: "string" },
            },
            required: ["spoken_summary", "full_response", "reasoning_summary", "uncertainties", "next_examination"],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Workspace reasoning request failed");
  return normalizeResponse(JSON.parse(data.output_text || "{}"));
}

module.exports = { generateWorkspaceResponse };
```

The model prompt must instruct the reasoner to ground claims in committed entries, distinguish uncertainties, avoid inventing a decision, and return a brief voice-ready `spoken_summary`.

- [ ] **Step 4: Verify response service behavior**

Run: `npm.cmd test`

Expected: PASS.

- [ ] **Step 5: Commit grounded response generation**

```bash
git add lib/workspaceResponseService.js test/workspaceResponseService.test.js test/run.js
git commit -m "Add workspace-grounded reasoning responses"
```

### Task 5: Coordinate Substantive Voice Turns Around Shared State

**Files:**
- Create: `lib/turnCoordinatorService.js`
- Create: `test/turnCoordinatorService.test.js`
- Modify: `test/run.js`

- [ ] **Step 1: Write failing coordinator tests**

Add `require("./turnCoordinatorService.test");` to `test/run.js` and create:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createBoardState } = require("../lib/boardState");
const { createReasoningWorkspace } = require("../lib/reasoningWorkspace");
const { coordinateReasoningTurn } = require("../lib/turnCoordinatorService");

function createState() {
  return { board: createBoardState(), workspace: createReasoningWorkspace(), selected_item: null, recently_moved_item: null };
}

test("applies committed memory before generating grounded response and visual command", async () => {
  const state = createState();
  let responseContext;
  const result = await coordinateReasoningTurn({
    user_goal: "Cost predictability is important; compare the options.",
    turn_id: "turn-1",
  }, state, {
    updateProvider: async () => ({
      action: "update",
      operations: [
        { type: "add_entry", id: "criterion-cost", category: "criteria", content: "Cost predictability", origin: "user_stated", source_turn_id: "turn-1" },
      ],
      spoken_commit_notice: "I captured cost predictability as a criterion.",
    }),
    responseProvider: async (input) => {
      responseContext = input.workspace_context;
      return { spoken_summary: "I will compare the options against cost predictability.", full_response: "", reasoning_summary: "", uncertainties: [], next_examination: "" };
    },
    routeProvider: async () => ({
      intent_type: "develop_idea_map",
      artifact_type: "comparison_map",
      should_use_whiteboard: true,
      route_action: "use_whiteboard",
      board_strategy: "create_new_group",
      visual_summary_goal: "Compare options against cost predictability.",
      reason: "Comparison should be visual.",
      confidence: 0.9,
      required_context: [],
      preferred_model: "test",
      tool_plan: [],
    }),
  });

  assert.match(JSON.stringify(responseContext), /Cost predictability/);
  assert.equal(result.workspace_state.entries[0].status, "active");
  assert.equal(result.board_command.artifact_type, "comparison_map");
  assert.match(result.workspace_briefing, /Cost predictability/);
});

test("undo voice turns reverse reasoning state without invoking response generation", async () => {
  const state = createState();
  const result = await coordinateReasoningTurn({ user_goal: "Undo the last conclusion.", turn_id: "turn-2" }, state, {
    updateProvider: async () => ({ action: "undo", operations: [] }),
  });

  assert.equal(result.handled_by, "workspace");
  assert.equal(result.action, "undo");
});

test("committed corrections request board synchronization even for conversational routing", async () => {
  const state = createState();
  const result = await coordinateReasoningTurn({ user_goal: "Reliability is an objective, not a constraint.", turn_id: "turn-3" }, state, {
    updateProvider: async () => ({
      action: "update",
      operations: [{ type: "add_entry", id: "objective-reliability", category: "objectives", content: "Reliability", origin: "user_stated", source_turn_id: "turn-3" }],
      spoken_commit_notice: "",
    }),
    responseProvider: async () => ({ spoken_summary: "Understood.", full_response: "", reasoning_summary: "", uncertainties: [], next_examination: "" }),
    routeProvider: async () => ({
      intent_type: "answer_simple", artifact_type: "conversation", should_use_whiteboard: false,
      route_action: "answer_conversationally", board_strategy: "no_board", visual_summary_goal: "",
      reason: "The answer is concise.", confidence: 0.9, required_context: [], preferred_model: "test", tool_plan: [],
    }),
  });

  assert.equal(result.board_sync_required, true);
  assert.equal(result.board_command.sync_reason, "committed_workspace_change");
});
```

- [ ] **Step 2: Confirm the coordinator tests fail**

Run: `npm.cmd test`

Expected: FAIL because `../lib/turnCoordinatorService` does not exist.

- [ ] **Step 3: Implement the coordinator contract**

Create `lib/turnCoordinatorService.js`:

```js
const { proposeWorkspaceUpdate } = require("./workspaceUpdateService");
const { applyWorkspaceOperations, undoLastWorkspaceCheckpoint, getWorkspaceSnapshot } = require("./reasoningWorkspace");
const { buildCompactWorkspaceContext, buildRealtimeWorkspaceBriefing } = require("./workspaceContext");
const { generateWorkspaceResponse } = require("./workspaceResponseService");
const { routeUserIntent } = require("./intentRouter");
const { buildWhiteboardCommandFromIntent } = require("./whiteboardCommandService");

async function coordinateReasoningTurn(payload, state, options = {}) {
  const turnId = payload.turn_id || `turn-${Date.now().toString(36)}`;
  const update = await proposeWorkspaceUpdate({ ...payload, utterance: payload.user_goal, turn_id: turnId }, state.workspace, options);
  if (update.action === "undo") {
    const undone = undoLastWorkspaceCheckpoint(state.workspace);
    const workspaceContext = buildCompactWorkspaceContext(state.workspace);
    return {
      handled_by: "workspace",
      action: "undo",
      spoken_summary: undone.ok ? "I undid the last reasoning update." : "There is no reasoning update to undo.",
      workspace_state: undone.workspace_state,
      workspace_briefing: buildRealtimeWorkspaceBriefing(state.workspace),
      board_sync_required: undone.ok,
      board_command: undone.ok ? {
        command_type: "reorganize_artifact",
        artifact_type: "idea_map",
        user_goal: "Synchronize the board after reasoning undo.",
        change_description: "Reflect the current authoritative workspace.",
        target_confidence: 1,
        workspace_context: workspaceContext,
        sync_reason: "reasoning_undo",
      } : null,
    };
  }
  if (update.action === "clarify") {
    return { handled_by: "turn_coordinator", action: "clarify", spoken_summary: update.needs_clarification, workspace_state: getWorkspaceSnapshot(state.workspace) };
  }

  const applied = applyWorkspaceOperations(state.workspace, update.operations, { source: "coordinator", turn_id: turnId });
  const workspaceContext = buildCompactWorkspaceContext(state.workspace);
  const response = await generateWorkspaceResponse({ utterance: payload.user_goal, workspace_context: workspaceContext }, options);
  const intent = await routeUserIntent({ ...payload, collected_context: buildRealtimeWorkspaceBriefing(state.workspace) }, {
    board: state.board,
    decisionProvider: options.routeProvider,
  });
  const hasCommittedMutation = update.operations.some((operation) => operation.type !== "update_working_memory");
  const boardCommand = intent.should_use_whiteboard
    ? { ...buildWhiteboardCommandFromIntent(intent), workspace_context: workspaceContext, sync_reason: "reasoning_turn" }
    : hasCommittedMutation ? {
        command_type: "reorganize_artifact",
        artifact_type: "idea_map",
        user_goal: "Synchronize the board with updated committed reasoning.",
        change_description: "Reflect authoritative workspace changes.",
        target_confidence: 1,
        workspace_context: workspaceContext,
        sync_reason: "committed_workspace_change",
      } : null;

  return {
    handled_by: "turn_coordinator",
    action: "update",
    ...response,
    spoken_commit_notice: update.spoken_commit_notice,
    workspace_checkpoint_id: applied.undo_checkpoint_id,
    workspace_state: applied.workspace_state,
    workspace_briefing: buildRealtimeWorkspaceBriefing(state.workspace),
    intent,
    board_command: boardCommand,
    board_sync_required: Boolean(boardCommand),
  };
}

module.exports = { coordinateReasoningTurn };
```

When implementing, wrap response and routing failures separately: successfully applied workspace changes remain authoritative, the result includes `response_error` or `board_sync_error`, and the spoken summary explains the partial failure without discarding memory.

- [ ] **Step 4: Run the full suite**

Run: `npm.cmd test`

Expected: PASS.

- [ ] **Step 5: Commit coordinated turn processing**

```bash
git add lib/turnCoordinatorService.js test/turnCoordinatorService.test.js test/run.js
git commit -m "Coordinate voice reasoning through workspace state"
```

### Task 6: Make Whiteboard Jobs Project Workspace State

**Files:**
- Modify: `lib/whiteboardCommandService.js`
- Modify: `lib/whiteboardPlannerService.js`
- Modify: `lib/whiteboardJobService.js`
- Modify: `lib/boardState.js`
- Modify: `test/whiteboardCommandService.test.js`
- Modify: `test/whiteboardPlannerService.test.js`
- Modify: `test/whiteboardJobService.test.js`
- Modify: `test/boardState.test.js`

- [ ] **Step 1: Write failing board-projection tests**

Extend the existing tests:

```js
test("preserves workspace context on commands created from coordinated intent", () => {
  const command = normalizeWhiteboardCommand({
    command_type: "create_artifact",
    artifact_type: "comparison_map",
    user_goal: "Compare providers",
    workspace_context: { active_entries: { criteria: [{ id: "criterion-cost", content: "Cost predictability" }] } },
  });

  assert.equal(command.workspace_context.active_entries.criteria[0].id, "criterion-cost");
});
```

```js
test("planner receives committed workspace entries for board synchronization", () => {
  const input = buildWhiteboardPlanInput({
    user_goal: "Compare providers",
    target_artifact: "comparison_map",
    should_use_whiteboard: true,
    workspace_context: { active_entries: { criteria: [{ id: "criterion-cost", content: "Cost predictability", origin: "user_stated" }] } },
  }, createBoardState());

  assert.equal(input.workspace_context.active_entries.criteria[0].content, "Cost predictability");
});
```

```js
test("board nodes retain reasoning provenance metadata", () => {
  const board = createBoardState();
  applyBoardOperations(board, [{
    type: "create_node", id: "node-cost", text: "Cost predictability", x: 10, y: 20,
    workspace_entry_id: "criterion-cost", memory_status: "committed", origin: "user_stated",
  }]);

  assert.equal(board.nodes[0].workspace_entry_id, "criterion-cost");
  assert.equal(board.nodes[0].memory_status, "committed");
});
```

- [ ] **Step 2: Run tests and confirm metadata/context are currently dropped**

Run: `npm.cmd test`

Expected: FAIL because command normalization, planner input, or board node storage omits workspace fields.

- [ ] **Step 3: Pass workspace context through command and planner services**

In `normalizeWhiteboardCommand`, retain:

```js
workspace_context: input.workspace_context && typeof input.workspace_context === "object"
  ? { ...input.workspace_context }
  : null,
sync_reason: normalizeText(input.sync_reason || "workspace_update"),
```

In `planOperationsForCommand`, include `workspace_context: command.workspace_context` in the intent passed to `planWhiteboardOperations`.

In `buildWhiteboardPlanInput`, include:

```js
workspace_context: intent.workspace_context || null,
```

Update the planner prompt with:

```js
"Treat active committed workspace entries as authoritative. Reuse or update existing related nodes where possible. Tag nodes that directly represent workspace entries with workspace_entry_id, memory_status, and origin."
```

- [ ] **Step 4: Preserve visual provenance fields in board state and job results**

In the `create_node` and `update_node` branches of `lib/boardState.js`, retain optional fields:

```js
workspace_entry_id: operation.workspace_entry_id || null,
memory_status: operation.memory_status || "exploratory",
origin: operation.origin || null,
```

In `lib/whiteboardJobService.js`, add `sync_status` to serialized jobs; set it to `pending`, `synchronized`, or `failed` as the job moves through queue/apply/error states. A failed visual job must return the existing board snapshot and must not touch workspace state.

- [ ] **Step 5: Run board projection tests**

Run: `npm.cmd test`

Expected: PASS.

- [ ] **Step 6: Commit board projection support**

```bash
git add lib/whiteboardCommandService.js lib/whiteboardPlannerService.js lib/whiteboardJobService.js lib/boardState.js test/whiteboardCommandService.test.js test/whiteboardPlannerService.test.js test/whiteboardJobService.test.js test/boardState.test.js
git commit -m "Project workspace state onto whiteboard jobs"
```

### Task 7: Integrate The Voice Tool And Workspace HTTP Boundary

**Files:**
- Modify: `server.js`
- Create: `test/serverWorkspaceFlow.test.js`
- Modify: `test/run.js`

- [ ] **Step 1: Refactor server startup for testability and write failing endpoint tests**

Add `require("./serverWorkspaceFlow.test");` to `test/run.js`. Change the bottom of `server.js` so tests can import the app without opening port `3000`:

```js
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`TeamsForAI realtime demo running on http://localhost:${PORT}`);
  });
}

module.exports = { app, getSessionState, sessionStateStore, TOOL_DEFINITIONS, TOOLING_INSTRUCTIONS };
```

Create `test/serverWorkspaceFlow.test.js` using an ephemeral local HTTP server:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { app, getSessionState, TOOL_DEFINITIONS, TOOLING_INSTRUCTIONS } = require("../server");

async function withServer(run) {
  const server = app.listen(0);
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("session state includes a reasoning workspace", () => {
  const state = getSessionState("workspace-test");
  assert.equal(state.workspace.version, 0);
  assert.deepEqual(state.workspace.entries, []);
});

test("realtime tools and instructions expose coordinated reasoning", () => {
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.name === "coordinate_reasoning_turn"));
  assert.match(TOOLING_INSTRUCTIONS, /coordinate_reasoning_turn/);
});

test("workspace state and reasoning undo endpoints are available", async () => {
  await withServer(async (baseUrl) => {
    const stateResponse = await fetch(`${baseUrl}/workspace/state?client_session_id=workspace-http-test`);
    const state = await stateResponse.json();
    assert.equal(state.version, 0);

    const undoResponse = await fetch(`${baseUrl}/workspace/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_session_id: "workspace-http-test" }),
    });
    const undo = await undoResponse.json();
    assert.equal(undo.ok, false);
  });
});
```

- [ ] **Step 2: Run tests to see missing session/tool/endpoints**

Run: `npm.cmd test`

Expected: FAIL because the session has no `workspace`, coordinated tool is absent, or workspace endpoints are absent.

- [ ] **Step 3: Initialize workspace state and define the primary voice tool**

Import the new services in `server.js`:

```js
const { createReasoningWorkspace, getWorkspaceSnapshot, undoLastWorkspaceCheckpoint } = require("./lib/reasoningWorkspace");
const { buildCompactWorkspaceContext, buildRealtimeWorkspaceBriefing } = require("./lib/workspaceContext");
const { coordinateReasoningTurn } = require("./lib/turnCoordinatorService");
```

Extend new session state:

```js
workspace: createReasoningWorkspace(),
whiteboard_jobs: [],
```

Add `coordinate_reasoning_turn` to `TOOL_DEFINITIONS` with fields matching the current `delegate_to_orchestrator` context plus `turn_id`. Update `TOOLING_INSTRUCTIONS` so all substantive analysis, continuity, memory correction, reasoning undo, and workspace/board work goes through this tool; retain direct conversational replies for trivial speech.

- [ ] **Step 4: Route coordinated tool calls and return voice briefing updates**

Add the tool-handler branch before legacy delegation:

```js
if (toolName === "coordinate_reasoning_turn") {
  const state = getSessionState(clientSessionId);
  const result = await coordinateReasoningTurn(toolArgs, state);
  let whiteboardJob = null;
  if (result.board_command) {
    const job = createWhiteboardJob(state, result.board_command);
    whiteboardJob = { job_id: job.job_id, status: job.status, spoken_ack: job.spoken_ack };
  }
  return res.json({
    ...result,
    whiteboard_job: whiteboardJob,
    board_state: getBoardSnapshot(state.board),
    realtime_session_instructions: `${TOOLING_INSTRUCTIONS}\n\n${result.workspace_briefing || buildRealtimeWorkspaceBriefing(state.workspace)}`,
  });
}
```

Keep existing legacy tool handlers for compatibility until the milestone is validated.

- [ ] **Step 5: Add workspace state and reasoning undo endpoints**

Implement:

```js
app.get("/workspace/state", (req, res) => {
  const state = getSessionState(req.query?.client_session_id || "default");
  return res.json(getWorkspaceSnapshot(state.workspace));
});

app.post("/workspace/undo", (req, res) => {
  const state = getSessionState(req.body?.client_session_id || "default");
  const result = undoLastWorkspaceCheckpoint(state.workspace);
  const job = result.ok
    ? createWhiteboardJob(state, {
        command_type: "reorganize_artifact",
        artifact_type: "idea_map",
        user_goal: "Synchronize the board after a reasoning correction.",
        change_description: "Reflect the current authoritative workspace after reasoning undo.",
        target_confidence: 1,
        workspace_context: buildCompactWorkspaceContext(state.workspace),
        sync_reason: "reasoning_undo",
      })
    : null;
  return res.json({
    ...result,
    workspace_briefing: buildRealtimeWorkspaceBriefing(state.workspace),
    realtime_session_instructions: `${TOOLING_INSTRUCTIONS}\n\n${buildRealtimeWorkspaceBriefing(state.workspace)}`,
    board_sync_required: result.ok,
    whiteboard_job: job && { job_id: job.job_id, status: job.status, spoken_ack: job.spoken_ack },
  });
});
```

- [ ] **Step 6: Verify server integration**

Run: `npm.cmd test`

Expected: PASS.

- [ ] **Step 7: Commit the backend voice boundary**

```bash
git add server.js test/serverWorkspaceFlow.test.js test/run.js
git commit -m "Route voice reasoning through shared workspace"
```

### Task 8: Render The Workspace Ledger And Distinguish Visual Memory

**Files:**
- Modify: `public/index.html`
- Modify: `public/style.css`
- Modify: `public/app.js`
- Modify: `test/frontendLayout.test.js`

- [ ] **Step 1: Write failing UI contract tests**

Extend `test/frontendLayout.test.js`:

```js
test("frontend includes a committed workspace ledger and reasoning undo", () => {
  ["workspaceLedger", "workspaceStatus", "reasoningUndoBtn"].forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"`), `expected #${id} in frontend markup`);
  });
  assert.match(appJs, /renderWorkspace/);
  assert.match(appJs, /\/workspace\/undo/);
  assert.match(appJs, /session\.update/);
});

test("frontend labels tentative and committed board nodes", () => {
  assert.match(appJs, /memory_status/);
  assert.match(appJs, /exploratory/);
  assert.match(appJs, /committed/);
});
```

- [ ] **Step 2: Run UI tests and observe missing ledger behavior**

Run: `npm.cmd test`

Expected: FAIL because the workspace DOM and rendering functions do not exist.

- [ ] **Step 3: Add ledger markup and reasoning controls**

Add an aside panel in `public/index.html`, separate from the command pane:

```html
<aside class="workspace-ledger" aria-label="Shared reasoning workspace">
  <div class="workspace-ledger-header">
    <h2>Reasoning Workspace</h2>
    <p id="workspaceStatus" class="status">No committed reasoning yet.</p>
  </div>
  <div id="workspaceLedger" class="workspace-ledger-content"></div>
  <button id="reasoningUndoBtn" disabled>Undo Reasoning</button>
</aside>
```

- [ ] **Step 4: Add workspace rendering and realtime briefing updates**

In `public/app.js`, add:

```js
const workspaceLedgerEl = document.getElementById("workspaceLedger");
const workspaceStatusEl = document.getElementById("workspaceStatus");
const reasoningUndoBtn = document.getElementById("reasoningUndoBtn");
const WORKSPACE_LABELS = {
  problem: "Problem", objectives: "Objectives", constraints: "Constraints",
  assumptions: "Assumptions", options: "Options", criteria: "Criteria",
  decisions: "Decisions", open_questions: "Open questions",
};

function renderWorkspace(workspaceState) {
  clearElement(workspaceLedgerEl);
  const active = (workspaceState.entries || []).filter((entry) => entry.status === "active");
  Object.entries(WORKSPACE_LABELS).forEach(([category, label]) => {
    const entries = active.filter((entry) => entry.category === category);
    if (!entries.length) return;
    const section = document.createElement("section");
    section.className = "ledger-section";
    const heading = document.createElement("h3");
    heading.textContent = label;
    section.appendChild(heading);
    entries.forEach((entry) => {
      const item = document.createElement("div");
      item.className = `ledger-entry ${entry.origin}`;
      item.textContent = `${entry.content} (${entry.origin === "user_stated" ? "stated" : "inferred"})`;
      section.appendChild(item);
    });
    workspaceLedgerEl.appendChild(section);
  });
  workspaceStatusEl.textContent = active.length ? `Committed items: ${active.length}` : "No committed reasoning yet.";
  reasoningUndoBtn.disabled = !workspaceState.can_undo;
}

function updateRealtimeBriefing(instructions) {
  if (!instructions || !dc || dc.readyState !== "open") return;
  dc.send(JSON.stringify({
    type: "session.update",
    session: { type: "realtime", instructions },
  }));
}
```

Call `renderWorkspace(output.workspace_state)` and `updateRealtimeBriefing(output.realtime_session_instructions)` after coordinated tool output. Implement `undoReasoning()` using `/workspace/undo`, rendering returned state, tracking any returned whiteboard job, and refreshing the realtime briefing.

- [ ] **Step 5: Render node memory status and style the three-surface layout**

When constructing board nodes, use:

```js
const memoryStatus = node.memory_status || "exploratory";
item.className = `board-node ${node.emphasis === "primary" ? "primary" : ""} ${memoryStatus}`;
meta.textContent = memoryStatus === "committed"
  ? `${node.origin === "ai_inferred" ? "Inferred" : "Stated"} workspace item`
  : "Exploratory thought";
```

In `public/style.css`, add ledger placement and markers:

```css
.workspace-ledger {
  position: fixed;
  top: 18px;
  left: 18px;
  z-index: 30;
  width: 300px;
  max-height: calc(100vh - 300px);
  overflow: auto;
  padding: 1rem;
  border: 1px solid rgba(95, 111, 132, 0.18);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.92);
}
.ledger-section h3 { margin: 0.8rem 0 0.35rem; font-size: 0.82rem; text-transform: uppercase; }
.ledger-entry { margin: 0.3rem 0; padding: 0.45rem; border-radius: 6px; background: #f1f5f9; font-size: 0.82rem; }
.ledger-entry.ai_inferred { border-left: 3px solid #f59e0b; }
.ledger-entry.user_stated { border-left: 3px solid #2563eb; }
.board-node.exploratory { border-style: dashed; }
.board-node.committed { border-style: solid; }
```

Adjust existing board header/transcript offsets so neither overlaps the new left ledger panel on desktop; stack ledger safely in the mobile media query.

- [ ] **Step 6: Run frontend and full tests**

Run: `npm.cmd test`

Expected: PASS.

- [ ] **Step 7: Commit the visible reasoning workspace**

```bash
git add public/index.html public/style.css public/app.js test/frontendLayout.test.js
git commit -m "Add visible reasoning workspace ledger"
```

### Task 9: Complete Failure-State And Synchronization Behavior

**Files:**
- Modify: `lib/turnCoordinatorService.js`
- Modify: `lib/whiteboardJobService.js`
- Modify: `server.js`
- Modify: `public/app.js`
- Modify: `test/turnCoordinatorService.test.js`
- Modify: `test/whiteboardJobService.test.js`
- Modify: `test/serverWorkspaceFlow.test.js`
- Modify: `test/frontendLayout.test.js`

- [ ] **Step 1: Write failing partial-failure tests**

Add coordinator and job tests:

```js
test("keeps validly committed memory when grounded response fails", async () => {
  const state = createState();
  const result = await coordinateReasoningTurn({ user_goal: "Reliability is required", turn_id: "turn-failure" }, state, {
    updateProvider: async () => ({
      action: "update",
      operations: [{ type: "add_entry", id: "constraint-reliability", category: "constraints", content: "Reliability is required", origin: "user_stated", source_turn_id: "turn-failure" }],
    }),
    responseProvider: async () => { throw new Error("reasoner unavailable"); },
  });

  assert.equal(state.workspace.entries[0].status, "active");
  assert.match(result.response_error, /reasoner unavailable/);
});
```

```js
test("failed visual synchronization exposes stale state without affecting reasoning", async () => {
  const state = { board: createBoardState(), whiteboard_jobs: [] };
  const job = createWhiteboardJob(state, {
    command_type: "create_artifact",
    artifact_type: "idea_map",
    user_goal: "Represent current workspace",
    workspace_context: { active_entries: { objectives: [{ id: "goal-1", content: "Improve reliability" }] } },
  }, { autoStart: false });

  await runWhiteboardJob(state, job.job_id, {
    plannerOptions: {
      disableFallback: true,
      plannerProvider: async () => ({
        spoken_summary: "",
        reasoning_summary: "",
        layout_notes: "",
        missing_info: [],
        board_operations: [{ type: "create_edge", id: "bad-edge", from: "missing-a", to: "missing-b" }],
      }),
    },
  });

  assert.equal(job.sync_status, "failed");
  assert.match(job.error, /invalid operations/);
  assert.equal(state.board.nodes.length, 0);
});
```

Extend frontend contract assertions to check rendering of pending/failed synchronization messages.

- [ ] **Step 2: Run tests and confirm failure-state reporting is incomplete**

Run: `npm.cmd test`

Expected: FAIL on missing `response_error`, missing `sync_status`, or missing frontend state rendering.

- [ ] **Step 3: Implement explicit partial-failure results**

In `coordinateReasoningTurn`, apply validated memory before downstream work and catch response/routing errors:

```js
let response;
let responseError = "";
try {
  response = await generateWorkspaceResponse({ utterance: payload.user_goal, workspace_context: workspaceContext }, options);
} catch (error) {
  responseError = error.message;
  response = {
    spoken_summary: "I captured the reasoning update, but I could not complete the deeper analysis yet.",
    full_response: "",
    reasoning_summary: "",
    uncertainties: [],
    next_examination: "",
  };
}
```

Return `response_error: responseError`. Apply the same principle to route/visual command generation: return `board_sync_error` without reversing committed memory.

- [ ] **Step 4: Surface synchronization status to the browser**

Return `sync_status` from board jobs and display a concise ledger/status warning in `public/app.js`:

```js
if (job.sync_status === "failed") {
  workspaceStatusEl.textContent = "Workspace is current; visual board update failed.";
}
if (job.sync_status === "pending") {
  workspaceStatusEl.textContent = "Workspace updated; synchronizing board...";
}
```

- [ ] **Step 5: Run regression tests**

Run: `npm.cmd test`

Expected: PASS with tests for successful and partial-failure flows.

- [ ] **Step 6: Commit resilience behavior**

```bash
git add lib/turnCoordinatorService.js lib/whiteboardJobService.js server.js public/app.js test/turnCoordinatorService.test.js test/whiteboardJobService.test.js test/serverWorkspaceFlow.test.js test/frontendLayout.test.js
git commit -m "Handle reasoning and board synchronization failures"
```

### Task 10: Run End-To-End Verification Through Voice

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document runtime model roles and the milestone voice check**

Update `README.md` to describe:

```markdown
## Voice reasoning workspace

Substantive spoken turns update a session-only reasoning workspace. The ledger shows
committed problem statements, objectives, constraints, assumptions, options, criteria,
decisions, and open questions, while the board visualizes the same reasoning.

### Manual voice acceptance check

1. Start a live voice session and state a problem requiring structured thought.
2. Confirm the assistant responds and the ledger/board show aligned structured context.
3. Refer to a prior item without repeating its details; confirm continuity.
4. Correct an inferred assumption by voice; confirm the ledger records the correction.
5. Confirm the subsequent answer and board reflect the corrected context.
```

No new model-role environment variable is introduced: workspace extraction reuses `ORCHESTRATOR_MODEL` and grounded response generation reuses `BRAIN_MODEL`.

- [ ] **Step 2: Run all automated tests**

Run: `npm.cmd test`

Expected: all tests pass.

- [ ] **Step 3: Start the application for voice verification**

Run: `npm.cmd run dev`

Expected: the server reports that it is running on `http://localhost:3000`.

- [ ] **Step 4: Perform the voice acceptance flow**

Use the browser application with a configured OpenAI API key and speak a general reasoning sequence:

```text
"I need to choose an approach for a new internal capability. Reliability matters,
but I am still considering the possible options."

"Compare the options based on what I already said."

"Correction: reliability is an objective, not a strict constraint. Undo any conclusion
that treated it as mandatory."

"Now explain what remains undecided."
```

Expected:

- The first substantive utterance produces committed entries with provenance and a corresponding board artifact.
- The follow-up uses the prior workspace without generating an unrelated fresh map.
- The correction changes or supersedes the incorrect entry and triggers board reconciliation.
- The final response respects the corrected workspace.
- Speech remains concise while ledger and board provide detail.

- [ ] **Step 5: Stop the running development server after verification**

Terminate the `npm.cmd run dev` process after the manual acceptance check so no session remains running.

- [ ] **Step 6: Commit user-facing documentation and any verification fixes**

```bash
git add README.md
git commit -m "Document voice reasoning workspace workflow"
```

Do not include `.env` or any generated local transcripts in the commit.

## Subtasks By Role

**Backend/state:** Tasks 1-7 and 9 implement deterministic memory, model-mediated update proposals, coordinated reasoning, board synchronization, tool routing, and failure boundaries.

**Frontend/interaction:** Tasks 8-9 expose authoritative memory, provenance, reasoning undo, tentative/committed visual styling, dynamic realtime briefings, and failed synchronization status.

**Tooling/verification:** Task 10 documents and exercises the required voice path, while every task maintains automated regression coverage.

## Acceptance Criteria

- A live session owns an isolated two-layer reasoning workspace.
- Substantive voice turns update working memory and may create attributable committed entries.
- Subsequent spoken turns are grounded in active committed workspace entries.
- The speaking model receives refreshed workspace briefings through Realtime `session.update`.
- Users can correct or undo authoritative reasoning without confusing it with board layout undo.
- The ledger visibly shows active committed entries and distinguishes user-stated from AI-inferred content.
- The board can mark exploratory versus committed representations and refines related visuals on follow-up turns.
- A failed board update does not invalidate committed memory and is shown as a visible synchronization failure.
- Automated tests pass and the manual voice scenario demonstrates continuity, correction, and visual reconciliation.

## Risks And Open Questions

- Automatic commitment may over-promote inferred statements. Provenance and voice correction reduce the risk, but later milestones may need configurable promotion policies.
- Repeated `session.update` instructions must stay compact; briefing generation limits active and recent items to prevent prompt growth.
- The current deterministic board fallbacks create generic artifacts. They remain useful for testability, but model-backed board projection is necessary for high-quality live reasoning.
- The current code runs board updates asynchronously but other reasoning work synchronously. The coordinator must make pending visual work explicit rather than implying that the board is already synchronized.
- Realtime live acceptance depends on a working API key, microphone access, and model availability; automated tests cover contracts without making network calls.

## Recommended Next Step

Execute Tasks 1-10 in order with test-driven checkpoints and one commit per task. The state model and update-validation boundaries must land before any UI work, because the ledger must display authoritative data rather than becoming a second unvalidated transcript.

## Official API References

- OpenAI, [Realtime API with WebRTC](https://platform.openai.com/docs/guides/realtime-webrtc): the existing `/v1/realtime/calls` WebRTC setup and data-channel event transport.
- OpenAI, [Realtime conversations](https://platform.openai.com/docs/guides/realtime-function-calling): tool call output flow and session configuration updates.
- OpenAI, [Using realtime models](https://platform.openai.com/docs/guides/realtime-models-prompting): `session.update` support for updating connected-session instructions.
