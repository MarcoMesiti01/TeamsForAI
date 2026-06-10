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
  assert.equal(event.source_type, "dev");
  assert.equal(event.payload, null);
});

test("records explicit source type for live/test log separation", () => {
  const recorder = createEventRecorder({ logDir: makeTempDir() });

  const event = recorder.recordEvent({
    session_id: "session-a",
    source_type: "test",
    category: "tool",
    action: "execute",
    status: "completed",
    summary: "Tool completed",
  });

  assert.equal(event.source_type, "test");
  assert.equal(recorder.getSessionEvents("session-a")[0].source_type, "test");
});

test("creates trace ids with the requested prefix", () => {
  const recorder = createEventRecorder({ logDir: makeTempDir() });

  const traceId = recorder.makeTraceId("tool");

  assert.ok(traceId.startsWith("tool-"));
});

test("defaults getSessionEvents to the default session", () => {
  const recorder = createEventRecorder({ logDir: makeTempDir() });

  const event = recorder.recordEvent({
    category: "session",
    action: "create",
    status: "started",
    summary: "Session started",
  });

  const events = recorder.getSessionEvents();

  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, event.event_id);
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

test("serializes bigint and function payloads without throwing", () => {
  const recorder = createEventRecorder({ logDir: makeTempDir() });

  const event = recorder.recordEvent({
    session_id: "session-special",
    category: "frontend",
    action: "noop",
    status: "info",
    summary: "Special payload",
    payload: { count: 1n, handler: function namedHandler() {} },
  });

  assert.equal(event.payload.count, "1");
  assert.equal(event.payload.handler, "[Function namedHandler]");
});

test("treats explicit undefined payload as null", () => {
  const recorder = createEventRecorder({ logDir: makeTempDir() });

  const event = recorder.recordEvent({
    category: "frontend",
    action: "noop",
    status: "info",
    summary: "No payload",
    payload: undefined,
  });

  assert.equal(event.payload, null);
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
