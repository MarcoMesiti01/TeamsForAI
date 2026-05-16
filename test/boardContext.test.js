const test = require("node:test");
const assert = require("node:assert/strict");

const { createBoardState, applyBoardOperations } = require("../lib/boardState");
const { buildCompactBoardContext } = require("../lib/boardContext");

test("builds compact model-friendly board context", () => {
  const board = createBoardState();
  applyBoardOperations(board, [
    { type: "create_node", id: "node-1", text: "Problem", x: 10, y: 20 },
    { type: "create_node", id: "node-2", text: "Solution", x: 240, y: 20 },
    { type: "create_edge", id: "edge-1", from: "node-1", to: "node-2", label: "leads to" },
    { type: "create_group", id: "group-1", title: "Thesis", node_ids: ["node-1", "node-2"] },
  ], { source: "ai" });
  applyBoardOperations(board, [
    { type: "move_item", id: "node-2", x: 300, y: 120 },
  ], { source: "user" });

  const context = buildCompactBoardContext(board, {
    selected_item: { id: "node-1", type: "node" },
  });

  assert.equal(context.version, board.version);
  assert.deepEqual(context.nodes[0], { id: "node-1", title: "Problem" });
  assert.deepEqual(context.groups[0], { id: "group-1", title: "Thesis", node_ids: ["node-1", "node-2"] });
  assert.deepEqual(context.edges[0], { id: "edge-1", from: "node-1", to: "node-2", label: "leads to" });
  assert.equal(context.recent_operations.at(-1).type, "move_item");
  assert.equal(context.selected_item.id, "node-1");
  assert.equal(context.recently_moved_item.id, "node-2");
});
