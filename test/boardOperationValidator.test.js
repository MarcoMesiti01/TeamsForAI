const test = require("node:test");
const assert = require("node:assert/strict");

const { createBoardState, applyBoardOperations } = require("../lib/boardState");
const { validateBoardOperations } = require("../lib/boardOperationValidator");

test("drops edges that reference missing nodes", () => {
  const board = createBoardState();
  const result = validateBoardOperations([
    { type: "create_node", id: "node-1", text: "Known", x: 10, y: 20 },
    { type: "create_edge", id: "edge-1", from: "node-1", to: "node-missing", label: "bad" },
  ], board);

  assert.deepEqual(result.validOperations.map((operation) => operation.type), ["create_node"]);
  assert.match(result.warnings.join("\n"), /missing node references/);
});

test("drops unsupported operation types", () => {
  const board = createBoardState();
  const result = validateBoardOperations([
    { type: "draw_polygon", id: "shape-1" },
  ], board);

  assert.equal(result.validOperations.length, 0);
  assert.match(result.warnings.join("\n"), /unsupported operation type/);
});

test("allows edges to reference nodes created earlier in the same batch", () => {
  const board = createBoardState();
  const result = validateBoardOperations([
    { type: "create_node", id: "node-1", text: "First", x: 10, y: 20 },
    { type: "create_node", id: "node-2", text: "Second", x: 240, y: 20 },
    { type: "create_edge", id: "edge-1", from: "node-1", to: "node-2", label: "valid" },
  ], board);

  assert.equal(result.validOperations.length, 3);
  assert.deepEqual(result.warnings, []);
});

test("drops duplicate create IDs", () => {
  const board = createBoardState();
  applyBoardOperations(board, [
    { type: "create_node", id: "node-existing", text: "Existing", x: 0, y: 0 },
  ]);

  const result = validateBoardOperations([
    { type: "create_node", id: "node-existing", text: "Duplicate existing", x: 10, y: 20 },
    { type: "create_node", id: "node-new", text: "New", x: 30, y: 40 },
    { type: "create_node", id: "node-new", text: "Duplicate batch", x: 50, y: 60 },
  ], board);

  assert.deepEqual(result.validOperations.map((operation) => operation.text), ["New"]);
  assert.equal(result.warnings.length, 2);
});

test("drops operations with invalid coordinates", () => {
  const board = createBoardState();
  const result = validateBoardOperations([
    { type: "create_node", id: "node-1", text: "Bad x", x: Infinity, y: 20 },
    { type: "move_item", id: "node-2", x: 10, y: Number.NaN },
  ], board);

  assert.equal(result.validOperations.length, 0);
  assert.match(result.warnings.join("\n"), /finite coordinates/);
});

test("drops groups with invalid node references", () => {
  const board = createBoardState();
  const result = validateBoardOperations([
    { type: "create_node", id: "node-1", text: "Known", x: 10, y: 20 },
    { type: "create_group", id: "group-1", title: "Bad group", node_ids: ["node-1", "node-missing"] },
  ], board);

  assert.deepEqual(result.validOperations.map((operation) => operation.type), ["create_node"]);
  assert.match(result.warnings.join("\n"), /invalid node_ids/);
});

test("drops destructive operations unless explicitly allowed", () => {
  const board = createBoardState();
  applyBoardOperations(board, [
    { type: "create_node", id: "node-1", text: "Keep", x: 0, y: 0 },
  ]);

  const blocked = validateBoardOperations([
    { type: "delete_item", id: "node-1" },
  ], board);
  const allowed = validateBoardOperations([
    { type: "delete_item", id: "node-1" },
  ], board, { allowDestructive: true });

  assert.equal(blocked.validOperations.length, 0);
  assert.equal(allowed.validOperations.length, 1);
});
