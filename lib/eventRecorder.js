const fs = require("node:fs");
const path = require("node:path");

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createJsonClone(value) {
  try {
    if (value === undefined) {
      return null;
    }

    const seen = new WeakSet();

    function normalize(currentValue) {
      if (currentValue === undefined) {
        return null;
      }

      if (typeof currentValue === "bigint") {
        return currentValue.toString();
      }

      if (typeof currentValue === "function") {
        return `[Function ${currentValue.name || "anonymous"}]`;
      }

      if (currentValue === null || typeof currentValue !== "object") {
        return currentValue;
      }

      if (seen.has(currentValue)) {
        return "[Circular]";
      }

      seen.add(currentValue);

      if (Array.isArray(currentValue)) {
        return currentValue.map((item) => normalize(item));
      }

      const clone = {};
      Object.entries(currentValue).forEach(([key, entryValue]) => {
        clone[key] = normalize(entryValue);
      });
      return clone;
    }

    const normalized = normalize(value);
    return JSON.parse(JSON.stringify(normalized));
  } catch {
    return "[Unserializable payload]";
  }
}

function createEventRecorder(options = {}) {
  const logDir = options.logDir || path.join(process.cwd(), "runtime-logs");
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const maxEventsPerSession = Number.isInteger(options.maxEventsPerSession) && options.maxEventsPerSession > 0
    ? options.maxEventsPerSession
    : 100;
  const appendFileSync = options.appendFileSync || fs.appendFileSync;
  const mkdirSync = options.mkdirSync || fs.mkdirSync;
  const sessionEvents = new Map();

  function ensureLogDir() {
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      return;
    }
  }

  function getLogFilePath(timestamp) {
    return path.join(logDir, `${timestamp.slice(0, 10)}.jsonl`);
  }

  function makeTraceId(prefix = "trace") {
    return makeId(prefix);
  }

  function recordEvent(eventInput) {
    const timestamp = now().toISOString();
    const sessionId = eventInput?.session_id ?? "default";
    const sourceType = eventInput?.source_type || options.source_type || "dev";
    const event = {
      event_id: makeId("event"),
      timestamp,
      session_id: sessionId,
      trace_id: eventInput?.trace_id ?? makeTraceId(),
      source_type: sourceType,
      category: eventInput?.category,
      action: eventInput?.action,
      status: eventInput?.status,
      summary: eventInput?.summary,
      payload: eventInput?.payload === undefined ? null : createJsonClone(eventInput.payload),
    };

    const storedEvent = createJsonClone(event);
    const events = sessionEvents.get(sessionId) || [];
    events.push(storedEvent);
    while (events.length > maxEventsPerSession) {
      events.shift();
    }
    sessionEvents.set(sessionId, events);

    try {
      ensureLogDir();
      appendFileSync(getLogFilePath(timestamp), `${JSON.stringify(storedEvent)}\n`, "utf8");
    } catch {
      // Keep recording in memory even if disk logging fails.
    }

    return storedEvent;
  }

  function getSessionEvents(sessionId) {
    return createJsonClone(sessionEvents.get(sessionId ?? "default") || []);
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
