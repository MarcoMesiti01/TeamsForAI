const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

test("frontend renders command pane with model and settings selectors", () => {
  assert.match(html, /class="app-shell"/, "root layout should use the full-screen app shell");
  assert.match(html, /class="command-pane"/, "controls should render in the right command pane");
  assert.match(html, /class="settings-block"/, "settings should be grouped visibly in the command pane");
  assert.match(html, /<select id="modelInput">/, "model control should be a selector");
  assert.match(html, /<select id="voiceSelect">/, "voice setting should be a selector");
  assert.doesNotMatch(html, /class="panel controls"/, "legacy controls panel should not be used");

  [
    "modelInput",
    "voiceSelect",
    "connectBtn",
    "disconnectBtn",
    "micBtn",
    "undoBtn",
    "status",
    "transcript",
    "board",
  ].forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"`), `expected #${id} in frontend markup`);
  });
});

test("frontend polls asynchronous whiteboard jobs", () => {
  assert.match(appJs, /pendingWhiteboardJobs/, "frontend should track pending whiteboard jobs");
  assert.match(appJs, /\/board\/jobs\?client_session_id=/, "frontend should poll the board jobs endpoint");
  assert.match(appJs, /trackWhiteboardJob/, "frontend should track jobs returned from tool execution");
});
