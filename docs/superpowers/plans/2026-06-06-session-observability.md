# Session Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build full-fidelity local session observability with JSONL file logs and an in-product session timeline.

**Architecture:** Add a central backend event recorder that stores recent events in memory by session and appends every event to daily JSONL files under `runtime-logs/`. Instrument backend routes and model/board/job services with trace-linked events, expose session log endpoints, and add a frontend timeline that reads backend events and reports browser-only failures.

**Tech Stack:** Node.js, Express, plain browser JavaScript, Node `node:test`, JSONL file logging with `fs`.

---

## File Structure

- Create `lib/eventRecorder.js`: central event recorder with safe serialization, in-memory session event storage, daily JSONL append, trace/event id helpers, and a default singleton.
- Create `test/eventRecorder.test.js`: focused unit tests for recorder behavior, JSONL output, session event reads, circular payload serialization, and write failure tolerance.
- Modify `test/run.js`: include `eventRecorder.test.js`.
- Modify `.gitignore`: ignore `runtime-logs/`.
- Modify `server.js`: add logging endpoints and route-level instrumentation for `/session`, `/tools/execute`, `/board/commands`, `/board/jobs`, `/board/operations`, and `/board/undo`.
- Modify `lib/orchestratorService.js`: record orchestrator input, model request/response, fallback, and failure events.
- Modify `lib/brainService.js`: record brain delegation path, model input/output, board-first planner path, usage, and failures.
- Modify `lib/whiteboardPlannerService.js`: record planner input, raw output, normalized output, validation warnings, fallback, and failure events.
- Modify `lib/whiteboardCommandService.js`: pass trace/session recorder options through direct command planning.
- Modify `lib/whiteboardJobService.js`: record job lifecycle events and pass trace/session recorder options into command planning.
- Modify `public/index.html`: add a Session Log panel with filters and event list container.
- Modify `public/app.js`: add timeline rendering, client event reporting, log refresh, filter handling, and frontend instrumentation.
- Modify `public/style.css`: add layout and visual styles for the Session Log panel.
- Modify `test/frontendLayout.test.js`: assert the Session Log panel and client logging code exist.

## Task 1: Event Recorder Core

**Files:**
- Create: `lib/eventRecorder.js`
- Create: `test/eventRecorder.test.js`
- Modify: `test/run.js`
- Modify: `.gitignore`

- [ ] **Step 1: Write event recorder tests**

Create `test/eventRecorder.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createEventRecorder } = require("../lib/eventRecorder");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "teamsforai-events-"));
}

test("records session events in memory and appends JSONL files", () => {
  const logDir = makeTempDir();
  const recorder = createEventRecorder({
    logDir,
    now: () => new Date("2026-06-06T10:00:00.000Z"),
  });

  const event = recorder.recordEvent({
    session_id: "session-a",
    trace_id: "trace-a",
    category: "tool",
    action: "execute",
    status: "completed",
    summary: "Tool completed",
    payload: { tool: "delegate_to_orchestrator" },
  });

  assert.equal(event.session_id, "session-a");
  assert.equal(event.trace_id, "trace-a");
  assert.equal(event.category, "tool");
  assert.equal(event.timestamp, "2026-06-06T10:00:00.000Z");
  assert.ok(event.event_id.startsWith("event-"));

  const events = recorder.getSessionEvents("session-a");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.tool, "delegate_to_orchestrator");

  const filePath = path.join(logDir, "2026-06-06.jsonl");
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), event);
});

test("creates ids and default session values when caller omits them", () => {
  const recorder = createEventRecorder({ logDir: makeTempDir() });
  const event = recorder.recordEvent({
    category: "session",
    action: "create",
    status: "started",
    summary: "Session started",
  });

  assert.equal(event.session_id, "default");
  assert.ok(event.trace_id.startsWith("trace-"));
  assert.equal(event.payload, null);
});

test("serializes circular payloads without throwing", () => {
  const recorder = createEventRecorder({ logDir: makeTempDir() });
  const circular = { name: "root" };
  circular.self = circular;

  const event = recorder.recordEvent({
    session_id: "session-circular",
    category: "frontend",
    action: "client_event",
    status: "info",
    summary: "Circular payload",
    payload: circular,
  });

  assert.equal(event.payload.name, "root");
  assert.equal(event.payload.self, "[Circular]");
});

test("continues in memory when file writing fails", () => {
  const recorder = createEventRecorder({
    logDir: makeTempDir(),
    appendFileSync: () => {
      throw new Error("disk unavailable");
    },
  });

  const event = recorder.recordEvent({
    session_id: "session-memory",
    category: "error",
    action: "write_failure",
    status: "failed",
    summary: "Write failed",
    payload: { ok: false },
  });

  const events = recorder.getSessionEvents("session-memory");
  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, event.event_id);
});
```

- [ ] **Step 2: Run recorder tests and verify failure**

Run:

`node --test test/eventRecorder.test.js`

Expected: fail with `Cannot find module '../lib/eventRecorder'`.

- [ ] **Step 3: Implement the event recorder**

Create `lib/eventRecorder.js`:

```js
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_EVENTS_PER_SESSION = 500;
const DEFAULT_LOG_DIR = path.join(__dirname, "..", "runtime-logs");

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeClone(value) {
  if (value === undefined) return null;
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(value, (_key, current) => {
    if (typeof current === "function") return `[Function ${current.name || "anonymous"}]`;
    if (typeof current === "bigint") return current.toString();
    if (current && typeof current === "object") {
      if (seen.has(current)) return "[Circular]";
      seen.add(current);
    }
    return current;
  }));
}

function normalizeStatus(status) {
  const allowed = new Set(["started", "completed", "failed", "warning", "info"]);
  return allowed.has(status) ? status : "info";
}

function getLogFilePath(logDir, timestamp) {
  return path.join(logDir, `${timestamp.slice(0, 10)}.jsonl`);
}

function createEventRecorder(options = {}) {
  const logDir = options.logDir || process.env.RUNTIME_LOG_DIR || DEFAULT_LOG_DIR;
  const maxEventsPerSession = options.maxEventsPerSession || DEFAULT_MAX_EVENTS_PER_SESSION;
  const now = options.now || (() => new Date());
  const appendFileSync = options.appendFileSync || fs.appendFileSync;
  const mkdirSync = options.mkdirSync || fs.mkdirSync;
  const eventsBySession = new Map();

  function recordEvent(input = {}) {
    const timestamp = now().toISOString();
    const sessionId = String(input.session_id || input.client_session_id || "default");
    const event = {
      event_id: input.event_id || makeId("event"),
      timestamp,
      session_id: sessionId,
      trace_id: input.trace_id || makeId("trace"),
      category: String(input.category || "event"),
      action: String(input.action || "record"),
      status: normalizeStatus(input.status),
      summary: String(input.summary || ""),
      payload: safeClone(input.payload),
    };

    const sessionEvents = eventsBySession.get(sessionId) || [];
    sessionEvents.push(event);
    if (sessionEvents.length > maxEventsPerSession) {
      sessionEvents.splice(0, sessionEvents.length - maxEventsPerSession);
    }
    eventsBySession.set(sessionId, sessionEvents);

    try {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(getLogFilePath(logDir, timestamp), `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      return event;
    }

    return event;
  }

  function getSessionEvents(sessionId = "default") {
    return [...(eventsBySession.get(String(sessionId || "default")) || [])];
  }

  function makeTraceId(prefix = "trace") {
    return makeId(prefix);
  }

  return {
    recordEvent,
    getSessionEvents,
    makeTraceId,
  };
}

const defaultEventRecorder = createEventRecorder();

module.exports = {
  createEventRecorder,
  defaultEventRecorder,
};
```

- [ ] **Step 4: Add test runner entry and ignored log directory**

Modify `test/run.js` so the first lines are:

```js
require("./eventRecorder.test");
require("./modelPolicy.test");
require("./intentRouter.test");
```

Keep the remaining existing `require("./modelPolicy.test");` through `require("./frontendLayout.test");` entries after these lines.

Modify `.gitignore` by adding this line:

```gitignore
runtime-logs/
```

- [ ] **Step 5: Run recorder tests and full tests**

Run:

`node --test test/eventRecorder.test.js`

Expected: pass.

Run:

`npm test`

Expected: pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add .gitignore lib/eventRecorder.js test/eventRecorder.test.js test/run.js
git commit -m "feat: add session event recorder"
```

## Task 2: Backend Log Endpoints and Route Spans

**Files:**
- Modify: `server.js`
- Create: `test/logRoutes.test.js`
- Modify: `test/run.js`

- [ ] **Step 1: Write route tests for log endpoints**

Create `test/logRoutes.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const { createEventRecorder } = require("../lib/eventRecorder");

test("log endpoint helpers return current session events", () => {
  const recorder = createEventRecorder({
    appendFileSync: () => {},
    mkdirSync: () => {},
  });

  recorder.recordEvent({
    session_id: "session-route",
    trace_id: "trace-route",
    category: "frontend",
    action: "client_event",
    status: "info",
    summary: "Client event",
    payload: { button: "connect" },
  });

  const events = recorder.getSessionEvents("session-route");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.button, "connect");
});
```

Modify `test/run.js` to include:

```js
require("./logRoutes.test");
```

Place it immediately after `require("./eventRecorder.test");`.

- [ ] **Step 2: Run route tests and verify they pass before server wiring**

Run:

`node --test test/logRoutes.test.js`

Expected: pass. This guards the recorder contract used by the route implementation.

- [ ] **Step 3: Import the recorder in `server.js`**

At the top of `server.js`, add:

```js
const { defaultEventRecorder } = require("./lib/eventRecorder");
```

Add these helpers after `REALTIME_VOICES`:

```js
function nowMs() {
  return Date.now();
}

function durationMs(startedAt) {
  return Date.now() - startedAt;
}

function recordEvent(event) {
  return defaultEventRecorder.recordEvent(event);
}

function makeTraceId(prefix = "trace") {
  return defaultEventRecorder.makeTraceId(prefix);
}
```

- [ ] **Step 4: Add log endpoints before the catch-all route**

Insert before `app.get("*", (_req, res) => {`:

```js
app.get("/logs/session", (req, res) => {
  const clientSessionId = req.query?.client_session_id || "default";
  return res.json({
    ok: true,
    events: defaultEventRecorder.getSessionEvents(clientSessionId),
  });
});

app.post("/logs/client-event", (req, res) => {
  const clientSessionId = req.body?.client_session_id || "default";
  const event = recordEvent({
    session_id: clientSessionId,
    trace_id: req.body?.trace_id || makeTraceId("frontend"),
    category: req.body?.category || "frontend",
    action: req.body?.action || "client_event",
    status: req.body?.status || "info",
    summary: req.body?.summary || "Frontend event",
    payload: req.body?.payload || {},
  });
  return res.status(202).json({ ok: true, event });
});
```

- [ ] **Step 5: Instrument `/session`**

At the start of `app.post("/session", async (req, res) => {`, immediately inside the `try`, add:

```js
const traceId = makeTraceId("session");
const startedAt = nowMs();
recordEvent({
  session_id: "default",
  trace_id: traceId,
  category: "session",
  action: "realtime_session",
  status: "started",
  summary: "Realtime session creation started",
  payload: {
    query: req.query || {},
    content_type: req.get("content-type") || "",
    content_length: req.get("content-length") || "",
  },
});
```

Before the missing-SDP validation response and the invalid-SDP validation response, add a matching `recordEvent` with `status: "failed"`, `action: "realtime_session_validation"`, and the same debug payload returned to the client.

After the existing `selectedModel` calculation, add:

```js
recordEvent({
  session_id: "default",
  trace_id: traceId,
  category: "session",
  action: "realtime_model_selection",
  status: "info",
  summary: `Selected realtime model ${selectedModel} and voice ${selectedVoice}`,
  payload: {
    requested_model: frontendModelOverride,
    requested_voice: requestedVoice,
    selected_model: selectedModel,
    selected_voice: selectedVoice,
  },
});
```

Before returning upstream failure JSON, add:

```js
recordEvent({
  session_id: "default",
  trace_id: traceId,
  category: "session",
  action: "realtime_session",
  status: "failed",
  summary: "Realtime upstream call failed",
  payload: {
    status: response.status,
    details: responseText,
    duration_ms: durationMs(startedAt),
  },
});
```

Before `return res.send(responseText);`, add:

```js
recordEvent({
  session_id: "default",
  trace_id: traceId,
  category: "session",
  action: "realtime_session",
  status: "completed",
  summary: "Realtime session created",
  payload: {
    selected_model: selectedModel,
    selected_voice: selectedVoice,
    duration_ms: durationMs(startedAt),
  },
});
```

Inside the `catch`, before returning status 500, add a failed session event with `error.message` and `duration_ms`.

- [ ] **Step 6: Instrument `/tools/execute`**

Inside `app.post("/tools/execute", async (req, res) => {`, after `clientSessionId` is computed, add:

```js
const traceId = makeTraceId("tool");
const startedAt = nowMs();
recordEvent({
  session_id: clientSessionId,
  trace_id: traceId,
  category: "tool",
  action: "execute",
  status: "started",
  summary: `Tool execution started: ${toolName || "missing"}`,
  payload: {
    tool_name: toolName,
    arguments: toolArgs,
  },
});
```

When calling `routeUserIntent`, pass recorder metadata:

```js
}, {
  board: state.board,
  selected_item: state.selected_item,
  recently_moved_item: state.recently_moved_item,
  recorder: defaultEventRecorder,
  sessionId: clientSessionId,
  traceId,
});
```

When calling `createWhiteboardJob`, pass options:

```js
const job = createWhiteboardJob(state, command, {
  recorder: defaultEventRecorder,
  sessionId: clientSessionId,
  traceId,
});
```

When calling `delegateToBrain`, pass:

```js
const result = await delegateToBrain(intent, state, {
  recorder: defaultEventRecorder,
  sessionId: clientSessionId,
  traceId,
});
```

Before each successful response, assign the response object to a local `output`, record `status: "completed"` with full `output` and `duration_ms`, then `return res.json(output);`.

In the `catch`, record:

```js
recordEvent({
  session_id: req.body?.client_session_id || "default",
  trace_id: makeTraceId("tool-error"),
  category: "error",
  action: "tool_execute",
  status: "failed",
  summary: "Tool execution failed",
  payload: {
    error: error.message,
    body: req.body || {},
  },
});
```

- [ ] **Step 7: Instrument board routes**

For `/board/commands`, create `traceId = makeTraceId("board-command")`, record command start, pass recorder options into `createWhiteboardJob`, record response or failure.

For `/board/jobs`, record an info event with `jobs.length` and current `board_state.version`.

For `/board/operations`, create `traceId = makeTraceId("board-operation")`, record the incoming operations, call `applyBoardOperations`, then record:

```js
recordEvent({
  session_id: clientSessionId,
  trace_id: traceId,
  category: "board",
  action: "apply_operations",
  status: "completed",
  summary: `Applied ${operations.length} board operation(s)`,
  payload: {
    source: "user",
    operations,
    result,
    recently_moved_item: state.recently_moved_item,
  },
});
```

For `/board/undo`, record the undo result with category `board`, action `undo`, and status `completed` or `failed` based on `undo.ok`.

- [ ] **Step 8: Run tests**

Run:

`npm test`

Expected: pass.

- [ ] **Step 9: Commit**

Run:

```bash
git add server.js test/logRoutes.test.js test/run.js
git commit -m "feat: expose session log endpoints"
```

## Task 3: Service-Level Model, Planner, Job, and Board Events

**Files:**
- Modify: `lib/orchestratorService.js`
- Modify: `lib/brainService.js`
- Modify: `lib/whiteboardPlannerService.js`
- Modify: `lib/whiteboardCommandService.js`
- Modify: `lib/whiteboardJobService.js`
- Modify: `test/intentRouter.test.js`
- Modify: `test/brainService.test.js`
- Modify: `test/whiteboardPlannerService.test.js`
- Modify: `test/whiteboardJobService.test.js`

- [ ] **Step 1: Write service observability assertions**

In `test/whiteboardJobService.test.js`, add:

```js
test("whiteboard jobs emit lifecycle events", async () => {
  const events = [];
  const recorder = {
    recordEvent(event) {
      events.push(event);
      return event;
    },
  };
  const state = { board: createBoardState(), whiteboard_jobs: [] };
  const job = createWhiteboardJob(state, {
    command_type: "create_artifact",
    user_goal: "Map an observability system",
  }, {
    autoStart: false,
    recorder,
    sessionId: "session-job",
    traceId: "trace-job",
    plannerOptions: {
      plannerProvider: () => ({
        spoken_summary: "Mapped it.",
        reasoning_summary: "Created a minimal map.",
        layout_notes: "Two cards.",
        missing_info: [],
        board_operations: [
          { type: "create_node", id: "node-a", text: "Recorder", x: 120, y: 120 },
        ],
      }),
    },
  });

  await runWhiteboardJob(state, job.job_id, {
    recorder,
    sessionId: "session-job",
    traceId: "trace-job",
    plannerOptions: {
      plannerProvider: () => ({
        spoken_summary: "Mapped it.",
        reasoning_summary: "Created a minimal map.",
        layout_notes: "Two cards.",
        missing_info: [],
        board_operations: [
          { type: "create_node", id: "node-a", text: "Recorder", x: 120, y: 120 },
        ],
      }),
    },
  });

  assert.deepEqual(events.map((event) => event.action), [
    "queued",
    "planning",
    "applying",
    "completed",
  ]);
  assert.equal(events[0].session_id, "session-job");
  assert.equal(events[0].trace_id, "trace-job");
});
```

In `test/whiteboardPlannerService.test.js`, add:

```js
test("planner emits model and validation events", async () => {
  const events = [];
  const board = createBoardState();
  const plan = await planWhiteboardOperations({
    user_goal: "Map logging",
    should_use_whiteboard: true,
    target_artifact: "idea_map",
  }, board, {
    recorder: {
      recordEvent(event) {
        events.push(event);
        return event;
      },
    },
    sessionId: "session-planner",
    traceId: "trace-planner",
    plannerProvider: () => ({
      spoken_summary: "Mapped logging.",
      reasoning_summary: "Valid plan.",
      layout_notes: "Readable layout.",
      missing_info: [],
      board_operations: [
        { type: "create_node", id: "node-log", text: "Log", x: 120, y: 120 },
      ],
    }),
  });

  assert.equal(plan.used_fallback, false);
  assert.ok(events.some((event) => event.category === "model" && event.action === "whiteboard_planner"));
  assert.ok(events.some((event) => event.category === "board" && event.action === "validate_operations"));
});
```

- [ ] **Step 2: Run service tests and verify failure**

Run:

`node --test test/whiteboardJobService.test.js test/whiteboardPlannerService.test.js`

Expected: fail because service modules do not emit recorder events yet.

- [ ] **Step 3: Add local recorder helper patterns to service files**

In each service file that receives `options`, use this pattern:

```js
function recordEvent(options, event) {
  if (!options?.recorder?.recordEvent) return null;
  return options.recorder.recordEvent({
    session_id: options.sessionId || options.session_id || "default",
    trace_id: options.traceId || options.trace_id,
    ...event,
  });
}
```

Add it to:

- `lib/orchestratorService.js`
- `lib/brainService.js`
- `lib/whiteboardPlannerService.js`
- `lib/whiteboardCommandService.js`
- `lib/whiteboardJobService.js`

- [ ] **Step 4: Instrument whiteboard jobs**

In `createWhiteboardJob`, after `jobs.push(job);`, add:

```js
recordEvent(options, {
  category: "whiteboard_job",
  action: "queued",
  status: "started",
  summary: `Whiteboard job queued: ${job.job_id}`,
  payload: {
    job_id: job.job_id,
    command,
    status: job.status,
  },
});
```

In `runWhiteboardJob`, after status changes, record:

```js
recordEvent(options, {
  category: "whiteboard_job",
  action: "planning",
  status: "started",
  summary: `Whiteboard job planning: ${job.job_id}`,
  payload: serializeJob(job),
});
```

Before applying operations, record `action: "applying"`, `status: "started"`, and payload containing `job_id` and `board_operations`.

After completion, record `action: "completed"`, `status: "completed"`, and payload `serializeJob(job)`.

For `needs_clarification`, no valid operations, disabled fallback warnings, and catch failures, record `status: "failed"` or `status: "warning"` with `serializeJob(job)`.

- [ ] **Step 5: Pass planner observability from command service**

In `lib/whiteboardCommandService.js`, when calling `planWhiteboardOperations`, include:

```js
recorder: options.recorder,
sessionId: options.sessionId,
traceId: options.traceId,
```

Also record target resolution before returning:

```js
recordEvent(options, {
  category: "tool",
  action: "resolve_whiteboard_command",
  status: "completed",
  summary: `Resolved whiteboard command ${command.command_type}`,
  payload: {
    command,
    target_resolution: targetResolution,
  },
});
```

- [ ] **Step 6: Instrument planner model and validation path**

In `planWhiteboardOperations`, before calling `callWhiteboardPlannerModel`, record:

```js
recordEvent(options, {
  category: "model",
  action: "whiteboard_planner",
  status: "started",
  summary: `Whiteboard planner started for ${artifactType}`,
  payload: {
    model: modelSelection.model,
    model_role: modelSelection.role,
    planner_input: planInput,
  },
});
```

After planner output and validation, record:

```js
recordEvent(options, {
  category: "board",
  action: "validate_operations",
  status: validation.warnings.length ? "warning" : "completed",
  summary: `Validated ${validation.validOperations.length} planner operation(s)`,
  payload: {
    raw_board_operations: plannerOutput.board_operations,
    valid_operations: validation.validOperations,
    warnings: validation.warnings,
  },
});
```

Before returning the successful plan, record a completed `model` event with normalized planner output.

In the `catch`, record a failed `model` event with the error message before returning fallback.

In `buildFallbackPlan`, add optional `options` recorder event:

```js
recordEvent(options, {
  category: "model",
  action: "whiteboard_planner_fallback",
  status: "warning",
  summary: fallbackReason ? `Fallback planner used: ${fallbackReason}` : "Fallback planner used",
  payload: {
    planner_input: planInput,
    raw_board_operations: rawBoardOperations,
    valid_operations: validation.validOperations,
    warnings: [...sourceWarnings, ...validation.warnings],
  },
});
```

- [ ] **Step 7: Instrument orchestrator and brain services**

In `createOrchestratorDecision`, record an info event after building `input`:

```js
recordEvent(options, {
  category: "model",
  action: "orchestrator_input",
  status: "info",
  summary: "Built orchestrator input",
  payload: { input },
});
```

When returning fallback for explicit undo or model failure, record `action: "orchestrator_fallback"`.

In `callOrchestratorModel`, record started/completed/failed model events around the fetch call and include selected model, system prompt, input, raw response data, and normalized decision.

In `delegateToBrain`, record:

- `action: "brain_delegate"`, `status: "started"` with payload and compact board context.
- `action: "brain_board_path"`, `status: "completed"` when board-first planner work returns.
- `action: "brain_flight_path"`, `status: "completed"` for legacy flight work.
- `action: "brain_delegate"`, `status: "completed"` for general model output.

In `callBrainModel`, accept `options = {}` and record started/completed/failed events around the model call with full input, prompt, raw response data, parsed output, usage, and model role.

- [ ] **Step 8: Run service tests**

Run:

`node --test test/whiteboardJobService.test.js test/whiteboardPlannerService.test.js test/brainService.test.js test/intentRouter.test.js`

Expected: pass.

Run:

`npm test`

Expected: pass.

- [ ] **Step 9: Commit**

Run:

```bash
git add lib/orchestratorService.js lib/brainService.js lib/whiteboardPlannerService.js lib/whiteboardCommandService.js lib/whiteboardJobService.js test/intentRouter.test.js test/brainService.test.js test/whiteboardPlannerService.test.js test/whiteboardJobService.test.js
git commit -m "feat: trace model and whiteboard flows"
```

## Task 4: Frontend Session Log Timeline

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`
- Modify: `test/frontendLayout.test.js`

- [ ] **Step 1: Write frontend layout assertions**

Add to `test/frontendLayout.test.js`:

```js
test("frontend includes a session log timeline", () => {
  ["sessionLog", "sessionLogEvents", "logFilterAll", "logFilterError", "logFilterModel", "logFilterBoard", "logFilterJobs", "logFilterTools", "logFilterSession", "logFilterFrontend"].forEach((id) => {
    assert.match(indexHtml, new RegExp(`id="${id}"`));
  });
  assert.match(appJs, /function renderSessionLog/);
  assert.match(appJs, /function recordClientEvent/);
  assert.match(appJs, /\/logs\/session\?client_session_id=/);
  assert.match(appJs, /\/logs\/client-event/);
});
```

- [ ] **Step 2: Run frontend layout test and verify failure**

Run:

`node --test test/frontendLayout.test.js`

Expected: fail because the Session Log UI does not exist yet.

- [ ] **Step 3: Add Session Log markup**

In `public/index.html`, insert this panel after the transcript section and before the board section:

```html
      <section class="panel session-log-panel" aria-label="Session log" id="sessionLog">
        <div class="session-log-header">
          <div>
            <h2>Session Log</h2>
            <p class="muted">Runtime timeline for model, board, tool, job, session, frontend, and error events.</p>
          </div>
          <button id="refreshSessionLogBtn" type="button">Refresh</button>
        </div>
        <div class="session-log-filters" aria-label="Session log filters">
          <button id="logFilterAll" type="button" data-log-filter="all" class="active">All</button>
          <button id="logFilterError" type="button" data-log-filter="error">Errors</button>
          <button id="logFilterModel" type="button" data-log-filter="model">Model</button>
          <button id="logFilterBoard" type="button" data-log-filter="board">Board</button>
          <button id="logFilterJobs" type="button" data-log-filter="whiteboard_job">Jobs</button>
          <button id="logFilterTools" type="button" data-log-filter="tool">Tools</button>
          <button id="logFilterSession" type="button" data-log-filter="session">Session</button>
          <button id="logFilterFrontend" type="button" data-log-filter="frontend">Frontend</button>
        </div>
        <div id="sessionLogEvents" class="session-log-events"></div>
      </section>
```

- [ ] **Step 4: Add frontend log state and DOM constants**

Near the top of `public/app.js`, add:

```js
const sessionLogEventsEl = document.getElementById("sessionLogEvents");
const refreshSessionLogBtn = document.getElementById("refreshSessionLogBtn");
const logFilterButtons = Array.from(document.querySelectorAll("[data-log-filter]"));
```

Near the existing state variables, add:

```js
let currentLogFilter = "all";
let currentSessionEvents = [];
let sessionLogRefreshTimer = null;
```

- [ ] **Step 5: Add frontend logging functions**

Add after `appendDebug`:

```js
function summarizeEvent(event) {
  const status = event.status ? event.status.toUpperCase() : "INFO";
  const category = event.category || "event";
  return `${status} ${category}: ${event.summary || event.action || "Recorded event"}`;
}

function renderSessionLog(events = currentSessionEvents) {
  if (!sessionLogEventsEl) return;
  currentSessionEvents = events;
  clearElement(sessionLogEventsEl);

  const filtered = events.filter((event) => {
    if (currentLogFilter === "all") return true;
    if (currentLogFilter === "error") return event.status === "failed" || event.category === "error";
    return event.category === currentLogFilter;
  });

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "session-log-empty";
    empty.textContent = "No session log events for this filter yet.";
    sessionLogEventsEl.appendChild(empty);
    return;
  }

  filtered.slice(-80).reverse().forEach((event) => {
    const details = document.createElement("details");
    details.className = `session-log-event ${event.status || "info"}`;

    const summary = document.createElement("summary");
    const time = document.createElement("span");
    time.className = "session-log-time";
    time.textContent = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : "--:--:--";

    const label = document.createElement("span");
    label.className = "session-log-summary";
    label.textContent = summarizeEvent(event);

    const trace = document.createElement("span");
    trace.className = "session-log-trace";
    trace.textContent = event.trace_id ? event.trace_id.slice(0, 18) : "";

    summary.appendChild(time);
    summary.appendChild(label);
    summary.appendChild(trace);

    const raw = document.createElement("pre");
    raw.textContent = JSON.stringify(event, null, 2);

    details.appendChild(summary);
    details.appendChild(raw);
    sessionLogEventsEl.appendChild(details);
  });
}

async function loadSessionLog() {
  if (!sessionLogEventsEl) return;
  try {
    const resp = await fetch(`/logs/session?client_session_id=${encodeURIComponent(clientSessionId)}`);
    const output = await resp.json();
    renderSessionLog(output.events || []);
  } catch (error) {
    appendLine("system", `Session log unavailable: ${error.message}`);
  }
}

async function recordClientEvent(action, status, summary, payload = {}) {
  try {
    await fetch("/logs/client-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_session_id: clientSessionId,
        category: "frontend",
        action,
        status,
        summary,
        payload,
      }),
    });
    await loadSessionLog();
  } catch {
    return;
  }
}

function setLogFilter(filter) {
  currentLogFilter = filter;
  logFilterButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.logFilter === filter);
  });
  renderSessionLog(currentSessionEvents);
}

function startSessionLogRefresh() {
  if (sessionLogRefreshTimer) return;
  sessionLogRefreshTimer = setInterval(() => {
    void loadSessionLog();
  }, 2000);
}

function stopSessionLogRefresh() {
  if (!sessionLogRefreshTimer) return;
  clearInterval(sessionLogRefreshTimer);
  sessionLogRefreshTimer = null;
}
```

- [ ] **Step 6: Wire frontend events**

In `bindDataChannel`, add:

```js
void recordClientEvent("data_channel_open", "completed", "Realtime data channel opened");
```

inside `channel.onopen`.

Add:

```js
void recordClientEvent("data_channel_close", "completed", "Realtime data channel closed");
```

inside `channel.onclose`.

Change the `catch` in `channel.onmessage` to:

```js
    } catch (error) {
      void recordClientEvent("data_channel_parse", "failed", "Realtime data-channel message parse failed", {
        error: error.message,
        raw_message: event.data,
      });
    }
```

In `executeToolCall`, before the fetch, add:

```js
void recordClientEvent("tool_call", "started", `Tool call started: ${name}`, {
  name,
  arguments: parsedArgs,
  call_id: callId,
});
```

After handling successful output, add:

```js
void recordClientEvent("tool_call", "completed", `Tool call completed: ${name}`, {
  name,
  call_id: callId,
  output,
});
```

In the `catch`, add a failed `tool_call` client event with `name`, `call_id`, and `error.message`.

In `pollWhiteboardJobs`, inside the `catch`, add:

```js
void recordClientEvent("board_job_poll", "failed", "Board job polling failed", { error: error.message });
```

In `finishNodeDrag`, after successful `renderBoard`, add a completed `board_drag_save` event with node id and coordinates. In the catch, add a failed `board_drag_save` event.

In `connect`, after successful connection, call `startSessionLogRefresh()` and `void loadSessionLog();`. In the catch, add a failed `realtime_connect` event. In `cleanup`, call `stopSessionLogRefresh()`.

- [ ] **Step 7: Wire filter controls and initial load**

Near the bottom of `public/app.js`, where existing event listeners are registered, add:

```js
if (refreshSessionLogBtn) {
  refreshSessionLogBtn.addEventListener("click", () => {
    void loadSessionLog();
  });
}

logFilterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setLogFilter(button.dataset.logFilter || "all");
  });
});

void loadSessionLog();
```

- [ ] **Step 8: Add Session Log styles**

Add to `public/style.css` near panel styles:

```css
.session-log-panel {
  min-height: 260px;
  max-height: 420px;
  overflow: hidden;
}

.session-log-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.session-log-header h2 {
  margin: 0;
}

.session-log-header button,
.session-log-filters button {
  border: 1px solid rgba(148, 163, 184, 0.45);
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.72);
  color: #e5e7eb;
  cursor: pointer;
  padding: 7px 10px;
}

.session-log-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}

.session-log-filters button.active {
  border-color: rgba(56, 189, 248, 0.9);
  color: #bae6fd;
}

.session-log-events {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 300px;
  overflow: auto;
  padding-right: 4px;
}

.session-log-event {
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.58);
  padding: 8px;
}

.session-log-event.failed {
  border-color: rgba(248, 113, 113, 0.8);
}

.session-log-event.warning {
  border-color: rgba(251, 191, 36, 0.75);
}

.session-log-event summary {
  display: grid;
  grid-template-columns: 72px 1fr auto;
  gap: 8px;
  cursor: pointer;
  list-style: none;
}

.session-log-time,
.session-log-trace {
  color: #94a3b8;
  font-size: 0.78rem;
}

.session-log-summary {
  color: #e5e7eb;
  font-size: 0.85rem;
}

.session-log-event pre {
  margin: 8px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: #cbd5e1;
  font-size: 0.75rem;
}

.session-log-empty {
  color: #94a3b8;
  font-size: 0.9rem;
}
```

- [ ] **Step 9: Run frontend tests and full tests**

Run:

`node --test test/frontendLayout.test.js`

Expected: pass.

Run:

`npm test`

Expected: pass.

- [ ] **Step 10: Commit**

Run:

```bash
git add public/index.html public/app.js public/style.css test/frontendLayout.test.js
git commit -m "feat: add session log timeline"
```

## Task 5: End-to-End Observability Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-06-06-session-observability-design.md` only if implementation changes the approved design

- [ ] **Step 1: Document local logs in README**

Add this section after the existing `## Usage` section in `README.md`:

```md
## Session Logs

The app records full-fidelity local runtime logs for debugging.

- Local JSONL files are written under `runtime-logs/YYYY-MM-DD.jsonl`.
- The browser shows a current-session Session Log panel with model, board, job, tool, session, frontend, and error events.
- Logs include full user text, model prompts, model responses, board operations, board state, and error details.
- `runtime-logs/` is ignored by git and should stay local.

Use these logs to reconstruct what happened in a session, including what was drawn on the whiteboard and which model/tool path produced it.
```

- [ ] **Step 2: Run full tests**

Run:

`npm test`

Expected: pass.

- [ ] **Step 3: Start the app**

Run:

`npm run dev`

Expected: terminal prints `TeamsForAI realtime demo running on http://localhost:3000`.

- [ ] **Step 4: Manually verify logging behavior**

In the browser at `http://localhost:3000`:

1. Open the app.
2. Confirm the Session Log panel renders.
3. Click Refresh and confirm session events appear.
4. Connect if an API key is configured.
5. Trigger a board-oriented request such as `Map the core idea for a voice-first AI whiteboard for startup founders.`
6. Confirm the Session Log panel shows session, tool, model, whiteboard job, and board events.
7. Drag a board card.
8. Confirm the Session Log panel shows a frontend drag event and a board operation event.

- [ ] **Step 5: Verify local JSONL output**

Run:

`Get-ChildItem runtime-logs`

Expected: at least one file named like `2026-06-06.jsonl`.

Run:

`Get-Content runtime-logs\\2026-06-06.jsonl -Tail 5`

Expected: each line is one valid JSON event containing `event_id`, `timestamp`, `session_id`, `trace_id`, `category`, `action`, `status`, `summary`, and `payload`.

- [ ] **Step 6: Verify git does not track runtime logs**

Run:

`git status --short runtime-logs`

Expected: no output.

- [ ] **Step 7: Commit documentation**

Run:

```bash
git add README.md docs/superpowers/specs/2026-06-06-session-observability-design.md
git commit -m "docs: describe session observability"
```

## Self-Review Checklist

- Spec coverage: recorder, JSONL files, `.gitignore`, backend session API, frontend client event API, model logging, board reconstruction logging, whiteboard job lifecycle, UI timeline, failure tolerance, and tests are each mapped to tasks.
- Open item scan: the plan contains no unresolved implementation items; each code-changing step names exact files and concrete code.
- Type consistency: event fields use `event_id`, `timestamp`, `session_id`, `trace_id`, `category`, `action`, `status`, `summary`, and `payload` consistently across backend, services, tests, and frontend.
