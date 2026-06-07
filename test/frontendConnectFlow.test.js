const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const Module = require("node:module");

function createExpressMock() {
  const routes = { get: new Map(), post: new Map() };

  function express() {
    return {
      use() {},
      get(routePath, handler) {
        routes.get.set(routePath, handler);
      },
      post(routePath, handler) {
        routes.post.set(routePath, handler);
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
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headers["content-type"] ||= "application/json";
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function invokeRoute(handler, req) {
  const res = makeResponse();
  await handler(req, res);
  return res;
}

function makeBrowserResponse({ status = 200, headers = {}, body = "" } = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return normalizedHeaders[String(name).toLowerCase()] || "";
      },
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async json() {
      return typeof body === "string" ? JSON.parse(body || "{}") : body;
    },
  };
}

class FakeElement {
  constructor(tagName = "div", id = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.textContent = "";
    this.disabled = false;
    this.value = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.classList = {
      add: (...names) => this.setClassNames(names, true),
      remove: (...names) => this.setClassNames(names, false),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !this.hasClass(name) : Boolean(force);
        this.setClassNames([name], shouldAdd);
        return shouldAdd;
      },
      contains: (name) => this.hasClass(name),
    };
  }

  hasClass(name) {
    return this.className.split(/\s+/).filter(Boolean).includes(name);
  }

  setClassNames(names, shouldAdd) {
    const current = new Set(this.className.split(/\s+/).filter(Boolean));
    names.forEach((name) => {
      if (shouldAdd) current.add(name);
      else current.delete(name);
    });
    this.className = Array.from(current).join(" ");
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  async click() {
    for (const handler of this.listeners.get("click") || []) {
      await handler({ currentTarget: this, target: this });
    }
  }

  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes[name] = stringValue;
    if (name === "class") this.className = stringValue;
    if (name.startsWith("data-")) {
      const datasetName = name
        .slice(5)
        .replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
      this.dataset[datasetName] = stringValue;
    }
  }

  getAttribute(name) {
    return this.attributes[name] || "";
  }

  querySelector(selector) {
    if (!selector.startsWith(".")) return null;
    const className = selector.slice(1);
    const pending = [...this.children];
    while (pending.length) {
      const element = pending.shift();
      if (element.hasClass?.(className)) return element;
      pending.push(...(element.children || []));
    }
    return null;
  }
}

function createFakeDocument() {
  const ids = [
    "modelInput",
    "voiceSelect",
    "connectBtn",
    "disconnectBtn",
    "micBtn",
    "status",
    "transcript",
    "undoBtn",
    "boardStatus",
    "board",
    "workspaceLedger",
    "workspaceStatus",
    "reasoningUndoBtn",
    "sessionLog",
    "sessionLogEvents",
    "refreshSessionLogBtn",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement("div", id)]));

  elements.get("modelInput").value = "gpt-realtime";
  elements.get("voiceSelect").value = "alloy";
  elements.get("disconnectBtn").disabled = true;
  elements.get("micBtn").disabled = true;

  return {
    elements,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement("div", id));
      return elements.get(id);
    },
    querySelectorAll() {
      return [];
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    createElementNS(_namespace, tagName) {
      return new FakeElement(tagName);
    },
  };
}

test("Connect button creates a provider-backed Realtime connection with the API key", async () => {
  const appJs = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const moduleLoad = Module._load;
  const mock = createExpressMock();
  const originalPort = process.env.PORT;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  let capturedProviderRequest = null;
  let capturedRemoteDescription = null;

  process.env.PORT = "0";
  process.env.OPENAI_API_KEY = "provider-api-key";
  global.fetch = async (url, options) => {
    capturedProviderRequest = { url, options };
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "application/sdp" : "";
        },
      },
      text: async () => "v=0\r\nprovider-answer\r\n",
    };
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "express") return mock.express;
    if (request === "dotenv") return { config() {} };
    return moduleLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve("../server")];
    require("../server");

    const postSession = mock.routes.post.get("/session");
    assert.ok(postSession, "POST /session should be registered");

    const document = createFakeDocument();
    const frontendFetch = async (url, options = {}) => {
      if (String(url).startsWith("/session?")) {
        const requestUrl = new URL(String(url), "http://local.test");
        const response = await invokeRoute(postSession, {
          query: Object.fromEntries(requestUrl.searchParams.entries()),
          body: options.body,
          get(name) {
            const lowerName = String(name).toLowerCase();
            if (lowerName === "content-type") return options.headers?.["Content-Type"] || "";
            if (lowerName === "content-length") return String(options.body?.length || 0);
            return "";
          },
        });
        return makeBrowserResponse({
          status: response.statusCode,
          headers: response.headers,
          body: response.body,
        });
      }

      if (String(url).startsWith("/workspace/state")) {
        return makeBrowserResponse({
          body: { version: 0, entries: [], working_memory: {}, can_undo: false },
        });
      }

      if (String(url).startsWith("/logs/session")) {
        return makeBrowserResponse({ body: { events: [] } });
      }

      if (String(url) === "/logs/client-event") {
        return makeBrowserResponse({
          body: {
            event: {
              timestamp: "2026-06-07T00:00:00.000Z",
              category: "frontend",
              action: "realtime_connect",
              status: "completed",
              summary: "Client event recorded",
            },
          },
        });
      }

      throw new Error(`Unexpected frontend fetch: ${url}`);
    };

    class FakePeerConnection {
      async createOffer() {
        return { type: "offer", sdp: "v=0\r\nbrowser-offer\r\n" };
      }

      async setLocalDescription(description) {
        this.localDescription = description;
      }

      async setRemoteDescription(description) {
        capturedRemoteDescription = description;
      }

      addTrack() {}

      createDataChannel() {
        return {
          readyState: "connecting",
          send() {},
          close() {},
        };
      }

      close() {}
    }

    const context = {
      console,
      document,
      fetch: frontendFetch,
      FormData,
      URL,
      URLSearchParams,
      Date,
      JSON,
      setInterval: () => 1,
      clearInterval: () => {},
      window: {
        addEventListener() {},
        setInterval: () => 1,
        clearInterval: () => {},
      },
      crypto: {
        randomUUID: () => "client-123",
      },
      navigator: {
        mediaDevices: {
          async getUserMedia(constraints) {
            assert.equal(constraints.audio, true);
            const audioTrack = { enabled: true, stop() {} };
            return {
              getAudioTracks: () => [audioTrack],
              getTracks: () => [audioTrack],
            };
          },
        },
      },
      RTCPeerConnection: FakePeerConnection,
    };

    vm.runInNewContext(appJs, context, { filename: "public/app.js" });

    await document.elements.get("connectBtn").click();

    const transcriptText = document.elements.get("transcript").children.map((child) => child.textContent).join("\n");
    assert.ok(capturedProviderRequest, transcriptText || document.elements.get("status").textContent);
    assert.equal(capturedProviderRequest.url, "https://api.openai.com/v1/realtime/calls");
    assert.equal(capturedProviderRequest.options.method, "POST");
    assert.equal(capturedProviderRequest.options.headers.Authorization, "Bearer provider-api-key");

    const providerBody = capturedProviderRequest.options.body;
    assert.equal(providerBody.get("sdp"), "v=0\r\nbrowser-offer\r\n");
    const sessionConfig = JSON.parse(providerBody.get("session"));
    assert.equal(sessionConfig.type, "realtime");
    assert.equal(sessionConfig.model, "gpt-realtime");
    assert.equal(sessionConfig.audio.output.voice, "alloy");
    assert.ok(sessionConfig.tools.some((tool) => tool.name === "coordinate_reasoning_turn"));

    assert.equal(capturedRemoteDescription.type, "answer");
    assert.equal(capturedRemoteDescription.sdp, "v=0\r\nprovider-answer\r\n");
    assert.match(
      transcriptText,
      /Connected using model: gpt-realtime and voice: alloy \(server\)/
    );
    assert.equal(document.elements.get("disconnectBtn").disabled, false, transcriptText);
    assert.equal(document.elements.get("micBtn").disabled, false, transcriptText);
  } finally {
    Module._load = moduleLoad;
    global.fetch = originalFetch;
    delete require.cache[require.resolve("../server")];
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("Connect button falls back through a schema-valid client secret when server SDP exchange fails", async () => {
  const appJs = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const moduleLoad = Module._load;
  const mock = createExpressMock();
  const originalPort = process.env.PORT;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  let capturedTokenRequest = null;
  let capturedDirectRealtimeRequest = null;
  let capturedRemoteDescription = null;
  const loggedSchemaError =
    "Invalid schema for function 'coordinate_reasoning_turn': schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'not' at the top level.";

  process.env.PORT = "0";
  process.env.OPENAI_API_KEY = "provider-api-key";
  global.fetch = async (url, options) => {
    if (url === "https://api.openai.com/v1/realtime/calls") {
      return {
        ok: false,
        status: 504,
        headers: {
          get(name) {
            return name.toLowerCase() === "content-type" ? "text/html" : "";
          },
        },
        text: async () => "<!doctype html><title>504: Gateway Timeout</title>",
      };
    }

    if (url === "https://api.openai.com/v1/realtime/client_secrets") {
      capturedTokenRequest = { url, options };
      const payload = JSON.parse(options.body);
      const invalidTool = payload.session.tools.find((tool) => tool.parameters?.anyOf);
      if (invalidTool) {
        return {
          ok: false,
          status: 400,
          headers: {
            get(name) {
              return name.toLowerCase() === "content-type" ? "application/json" : "";
            },
          },
          text: async () => JSON.stringify({
            error: {
              message: loggedSchemaError,
            },
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name.toLowerCase() === "content-type" ? "application/json" : "";
          },
        },
        text: async () => JSON.stringify({
          client_secret: { value: "ephemeral-provider-key", expires_at: 123 },
          session: payload.session,
        }),
      };
    }

    throw new Error(`Unexpected provider fetch: ${url}`);
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "express") return mock.express;
    if (request === "dotenv") return { config() {} };
    return moduleLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve("../server")];
    require("../server");

    const postSession = mock.routes.post.get("/session");
    const getToken = mock.routes.get.get("/token");
    assert.ok(postSession, "POST /session should be registered");
    assert.ok(getToken, "GET /token should be registered");

    const document = createFakeDocument();
    const frontendFetch = async (url, options = {}) => {
      if (String(url).startsWith("/session?")) {
        const requestUrl = new URL(String(url), "http://local.test");
        const response = await invokeRoute(postSession, {
          query: Object.fromEntries(requestUrl.searchParams.entries()),
          body: options.body,
          get(name) {
            const lowerName = String(name).toLowerCase();
            if (lowerName === "content-type") return options.headers?.["Content-Type"] || "";
            if (lowerName === "content-length") return String(options.body?.length || 0);
            return "";
          },
        });
        return makeBrowserResponse({
          status: response.statusCode,
          headers: response.headers,
          body: response.body,
        });
      }

      if (String(url).startsWith("/token?")) {
        const requestUrl = new URL(String(url), "http://local.test");
        const response = await invokeRoute(getToken, {
          query: Object.fromEntries(requestUrl.searchParams.entries()),
          get() {
            return "";
          },
        });
        return makeBrowserResponse({
          status: response.statusCode,
          headers: response.headers,
          body: response.body,
        });
      }

      if (String(url) === "https://api.openai.com/v1/realtime/calls") {
        capturedDirectRealtimeRequest = { url, options };
        return makeBrowserResponse({
          status: 200,
          headers: { "content-type": "application/sdp" },
          body: "v=0\r\ndirect-provider-answer\r\n",
        });
      }

      if (String(url).startsWith("/workspace/state")) {
        return makeBrowserResponse({
          body: { version: 0, entries: [], working_memory: {}, can_undo: false },
        });
      }

      if (String(url).startsWith("/logs/session")) {
        return makeBrowserResponse({ body: { events: [] } });
      }

      if (String(url) === "/logs/client-event") {
        return makeBrowserResponse({
          body: {
            event: {
              timestamp: "2026-06-07T00:00:00.000Z",
              category: "frontend",
              action: "realtime_connect",
              status: "completed",
              summary: "Client event recorded",
            },
          },
        });
      }

      throw new Error(`Unexpected frontend fetch: ${url}`);
    };

    class FakePeerConnection {
      async createOffer() {
        return { type: "offer", sdp: "v=0\r\nbrowser-offer\r\n" };
      }

      async setLocalDescription(description) {
        this.localDescription = description;
      }

      async setRemoteDescription(description) {
        capturedRemoteDescription = description;
      }

      addTrack() {}

      createDataChannel() {
        return {
          readyState: "connecting",
          send() {},
          close() {},
        };
      }

      close() {}
    }

    const context = {
      console,
      document,
      fetch: frontendFetch,
      FormData,
      URL,
      URLSearchParams,
      Date,
      JSON,
      setInterval: () => 1,
      clearInterval: () => {},
      window: {
        addEventListener() {},
        setInterval: () => 1,
        clearInterval: () => {},
      },
      crypto: {
        randomUUID: () => "client-123",
      },
      navigator: {
        mediaDevices: {
          async getUserMedia(constraints) {
            assert.equal(constraints.audio, true);
            const audioTrack = { enabled: true, stop() {} };
            return {
              getAudioTracks: () => [audioTrack],
              getTracks: () => [audioTrack],
            };
          },
        },
      },
      RTCPeerConnection: FakePeerConnection,
    };

    vm.runInNewContext(appJs, context, { filename: "public/app.js" });

    await document.elements.get("connectBtn").click();

    const transcriptText = document.elements.get("transcript").children.map((child) => child.textContent).join("\n");
    assert.ok(capturedTokenRequest, transcriptText || document.elements.get("status").textContent);
    assert.ok(capturedDirectRealtimeRequest, transcriptText || document.elements.get("status").textContent);
    assert.equal(capturedTokenRequest.options.headers.Authorization, "Bearer provider-api-key");
    assert.equal(capturedDirectRealtimeRequest.options.headers.Authorization, "Bearer ephemeral-provider-key");
    assert.equal(capturedDirectRealtimeRequest.options.body, "v=0\r\nbrowser-offer\r\n");
    assert.equal(capturedRemoteDescription.type, "answer");
    assert.equal(capturedRemoteDescription.sdp, "v=0\r\ndirect-provider-answer\r\n");
    assert.match(
      transcriptText,
      /Connected using model: gpt-realtime and voice: alloy \(direct\)/
    );
    assert.doesNotMatch(transcriptText, new RegExp(loggedSchemaError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    Module._load = moduleLoad;
    global.fetch = originalFetch;
    delete require.cache[require.resolve("../server")];
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});
