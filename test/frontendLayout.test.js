const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");

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

test("frontend realtime model selector avoids stale preview models", () => {
  assert.match(html, /<option value="gpt-realtime">gpt-realtime<\/option>/);
  assert.match(html, /<option value="gpt-realtime-1\.5">gpt-realtime-1\.5<\/option>/);
  assert.match(html, /<option value="gpt-realtime-mini">gpt-realtime-mini<\/option>/);
  assert.doesNotMatch(html, /gpt-4o-realtime-preview/);
});

test("frontend polls asynchronous whiteboard jobs", () => {
  assert.match(appJs, /pendingWhiteboardJobs/, "frontend should track pending whiteboard jobs");
  assert.match(appJs, /\/board\/jobs\?client_session_id=.*quiet=1/, "frontend should poll the board jobs endpoint quietly");
  assert.match(appJs, /trackWhiteboardJob/, "frontend should track jobs returned from tool execution");
  assert.match(appJs, /workspaceSyncJobs/, "frontend should track workspace-backed sync jobs separately");
  assert.match(appJs, /BOARD_JOB_INITIAL_POLL_DELAY_MS/, "frontend should use adaptive job polling");
  assert.match(appJs, /BOARD_JOB_MAX_POLL_DELAY_MS/, "frontend should cap adaptive job polling delay");
  assert.match(appJs, /recordBoardJobPollSummary/, "frontend should log one polling summary instead of every poll");
});

test("frontend includes a committed workspace ledger and reasoning undo", () => {
  assert.match(html, /<h2>Shared reasoning workspace<\/h2>/, "workspace ledger should have the required visible label");
  ["workspaceLedger", "workspaceStatus", "reasoningUndoBtn"].forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"`), `expected #${id} in frontend markup`);
  });
  assert.match(appJs, /renderWorkspace/);
  assert.match(appJs, /updateRealtimeBriefing/);
  assert.match(appJs, /renderWorkspace\(output\.workspace_state\)/);
  assert.match(appJs, /\/workspace\/undo/);
  assert.match(appJs, /\/workspace\/state\?client_session_id=/);
  assert.match(appJs, /session\.update/);
  assert.match(appJs, /coordinate_reasoning_turn/);
  assert.match(appJs, /reasoningUndoInFlight/, "reasoning undo should be guarded while a request is in flight");
  assert.match(appJs, /Array\.isArray\(workspaceState\.entries\)/, "workspace rendering should tolerate malformed entries");
});

test("frontend labels tentative and committed board nodes", () => {
  assert.match(appJs, /memory_status/);
  assert.match(appJs, /exploratory/);
  assert.match(appJs, /committed/);
  assert.match(appJs, /node\.memory_status === "committed" \? "committed" : "exploratory"/);
});

test("frontend surfaces workspace-to-board synchronization status without marking reasoning failed", () => {
  assert.match(appJs, /setWorkspaceSyncStatus/);
  assert.match(appJs, /Reasoning complete; board updating\.\.\./);
  assert.match(appJs, /Board updated\./);
  assert.match(appJs, /Workspace is current; visual board update failed\./);
  assert.match(appJs, /Workspace is current; visual board update needs clarification\./);
  assert.match(appJs, /job\.workspace_sync/);
  assert.match(appJs, /job\.status === "needs_clarification"[\s\S]*visual board update needs clarification/);
  assert.match(appJs, /workspaceSyncJobs\.delete\(job\.job_id\);[\s\S]*Board update needs clarification/);
  assert.match(appJs, /latestWorkspaceSyncJobId = job\.job_id/);
  assert.match(appJs, /job\.job_id !== latestWorkspaceSyncJobId/);
  assert.doesNotMatch(appJs, /Workspace failed/);
});

test("frontend offsets board content away from the workspace ledger", () => {
  assert.match(css, /\.workspace-ledger[\s\S]*width: 300px;/);
  assert.match(css, /\.board[\s\S]*width: calc\(100% - 320px\);[\s\S]*margin-left: 320px;/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.board[\s\S]*width: 100%;[\s\S]*margin-left: 0;/);
});

test("frontend includes a committed workspace ledger and reasoning undo", () => {
  ["workspaceLedger", "workspaceStatus", "reasoningUndoBtn"].forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"`), `expected #${id} in frontend markup`);
  });
  assert.match(appJs, /renderWorkspace/);
  assert.match(appJs, /updateRealtimeBriefing/);
  assert.match(appJs, /renderWorkspace\(output\.workspace_state\)/);
  assert.match(appJs, /\/workspace\/undo/);
  assert.match(appJs, /\/workspace\/state\?client_session_id=/);
  assert.match(appJs, /session\.update/);
  assert.match(appJs, /coordinate_reasoning_turn/);
});

test("frontend labels tentative and committed board nodes", () => {
  assert.match(appJs, /memory_status/);
  assert.match(appJs, /exploratory/);
  assert.match(appJs, /committed/);
});

test("frontend includes a session log timeline", () => {
  [
    "sessionLog",
    "sessionLogEvents",
    "refreshSessionLogBtn",
    "logFilterAll",
    "logFilterError",
    "logFilterModel",
    "logFilterBoard",
    "logFilterJobs",
    "logFilterTools",
    "logFilterSession",
    "logFilterFrontend",
  ].forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"`), `expected #${id} in frontend markup`);
  });
  assert.match(appJs, /function renderSessionLog/);
  assert.match(appJs, /function recordClientEvent/);
  assert.match(appJs, /\/logs\/session\?client_session_id=/);
  assert.match(appJs, /\/logs\/client-event/);
});

test("frontend parses session failures before displaying and logging them", () => {
  assert.match(appJs, /async function readSessionError/);
  assert.match(appJs, /await readSessionError\(sdpResp\)/);
  assert.match(appJs, /contentType\.includes\("json"\)/);
  assert.doesNotMatch(appJs, /SDP exchange failed: \$\{text\}/);
});

test("frontend can fall back to direct Realtime WebRTC with an ephemeral token", () => {
  assert.match(appJs, /async function fetchEphemeralRealtimeToken/);
  assert.match(appJs, /async function createDirectRealtimeCall/);
  assert.match(appJs, /\/token\?/);
  assert.match(appJs, /https:\/\/api\.openai\.com\/v1\/realtime\/calls/);
  assert.match(appJs, /Authorization: `Bearer \$\{EPHEMERAL_KEY\}`/);
  assert.match(appJs, /if \(sdpResp\.status >= 500\)[\s\S]*createDirectRealtimeCall/);
});
