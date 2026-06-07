const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const { defaultEventRecorder } = require("../lib/eventRecorder");

function createExpressMock() {
  const routes = { get: new Map(), post: new Map() };

  function express() {
    return {
      use() {},
      get(path, handler) {
        routes.get.set(path, handler);
      },
      post(path, handler) {
        routes.post.set(path, handler);
      },
      listen() {
        return { close() {} };
      },
    };
  }

  express.text = () => (_req, _res, next) => next?.();
  express.json = () => (_req, _res, next) => next?.();
  express.static = () => (_req, _res, next) => next?.();

  return { express, routes };
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

function invoke(handler, req) {
  const res = makeResponse();
  return Promise.resolve(handler(req, res)).then(() => res);
}

test("GET /logs/session returns recorder events and POST /logs/client-event stores them", async () => {
  const moduleLoad = Module._load;
  const mock = createExpressMock();
  const uniqueSessionId = `session-${Date.now().toString(36)}`;
  const originalPort = process.env.PORT;

  process.env.PORT = "0";
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "express") {
      return mock.express;
    }
    return moduleLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve("../server")];
    require("../server");

    defaultEventRecorder.recordEvent({
      session_id: uniqueSessionId,
      trace_id: "trace-existing",
      category: "session",
      action: "started",
      status: "started",
      summary: "Existing session event",
    });

    const getSessionLogs = mock.routes.get.get("/logs/session");
    const postClientEvent = mock.routes.post.get("/logs/client-event");

    assert.ok(getSessionLogs, "GET /logs/session should be registered");
    assert.ok(postClientEvent, "POST /logs/client-event should be registered");

    const getResponse = await invoke(getSessionLogs, {
      query: { client_session_id: uniqueSessionId },
    });

    assert.equal(getResponse.statusCode, 200);
    assert.deepEqual(getResponse.body, {
      ok: true,
      events: defaultEventRecorder.getSessionEvents(uniqueSessionId),
    });

    const postResponse = await invoke(postClientEvent, {
      body: {
        client_session_id: uniqueSessionId,
        category: "frontend",
        action: "client_event",
        status: "info",
        summary: "Frontend event",
        payload: { kind: "ping" },
      },
    });

    assert.equal(postResponse.statusCode, 202);
    assert.equal(postResponse.body.ok, true);
    assert.equal(postResponse.body.event.session_id, uniqueSessionId);
    assert.equal(postResponse.body.event.category, "frontend");
    assert.equal(postResponse.body.event.action, "client_event");
    assert.equal(postResponse.body.event.status, "info");
    assert.deepEqual(postResponse.body.event.payload, { kind: "ping" });
    assert.equal(defaultEventRecorder.getSessionEvents(uniqueSessionId).length, 2);
  } finally {
    Module._load = moduleLoad;
    delete require.cache[require.resolve("../server")];
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }
  }
});
