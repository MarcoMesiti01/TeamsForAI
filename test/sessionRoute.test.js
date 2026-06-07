const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

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

test("POST /session summarizes non-JSON upstream failures without leaking HTML", async () => {
  const moduleLoad = Module._load;
  const mock = createExpressMock();
  const originalPort = process.env.PORT;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;

  process.env.PORT = "0";
  process.env.OPENAI_API_KEY = "test-key";
  global.fetch = async () => ({
    ok: false,
    status: 504,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type" ? "text/html" : "";
      },
    },
    text: async () => "<!DOCTYPE html><title>api.openai.com | 504: Gateway time-out</title>",
  });

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "express") {
      return mock.express;
    }
    if (request === "dotenv") {
      return { config() {} };
    }
    return moduleLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve("../server")];
    require("../server");

    const postSession = mock.routes.post.get("/session");
    assert.ok(postSession, "POST /session should be registered");

    const response = await invoke(postSession, {
      query: { voice: "alloy" },
      body: "v=0\r\ns=-\r\n",
      get(name) {
        if (name.toLowerCase() === "content-type") return "application/sdp";
        if (name.toLowerCase() === "content-length") return String(this.body.length);
        return "";
      },
    });

    assert.equal(response.statusCode, 504);
    assert.equal(response.body.error, "Failed to create realtime call.");
    assert.match(response.body.details, /OpenAI Realtime service returned HTTP 504/);
    assert.doesNotMatch(JSON.stringify(response.body), /<!DOCTYPE html|<title>|Cloudflare/i);
  } finally {
    Module._load = moduleLoad;
    global.fetch = originalFetch;
    delete require.cache[require.resolve("../server")];
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  }
});
