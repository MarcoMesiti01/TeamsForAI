const { getBoardSnapshot } = require("./boardState");

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactOperation(operation) {
  return {
    type: operation.type,
    id: operation.id || null,
    from: operation.from || null,
    to: operation.to || null,
    label: operation.label || null,
    checkpoint_id: operation.checkpoint_id || null,
    source: operation.source || null,
    version: Number.isFinite(operation.version) ? operation.version : null,
  };
}

function inferRecentlyMovedItem(snapshot) {
  const move = [...safeArray(snapshot.operation_log)]
    .reverse()
    .find((operation) => operation.type === "move_item" && operation.id);

  if (!move) return null;

  return {
    id: move.id,
    type: "node",
    x: Number.isFinite(move.x) ? move.x : null,
    y: Number.isFinite(move.y) ? move.y : null,
    version: Number.isFinite(move.version) ? move.version : null,
  };
}

function buildCompactBoardContext(board, options = {}) {
  const snapshot = board ? getBoardSnapshot(board) : {
    version: 0,
    nodes: [],
    edges: [],
    groups: [],
    operation_log: [],
    can_undo: false,
  };

  return {
    version: Number.isFinite(snapshot.version) ? snapshot.version : 0,
    nodes: safeArray(snapshot.nodes).slice(-40).map((node) => ({
      id: node.id,
      title: node.text,
    })),
    groups: safeArray(snapshot.groups).slice(-20).map((group) => ({
      id: group.id,
      title: group.title,
      node_ids: safeArray(group.node_ids).slice(0, 40),
    })),
    edges: safeArray(snapshot.edges).slice(-60).map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: edge.label || "",
    })),
    recent_operations: safeArray(snapshot.operation_log).slice(-12).map(compactOperation),
    selected_item: options.selected_item || options.selectedItem || null,
    recently_moved_item: options.recently_moved_item || options.recentlyMovedItem || inferRecentlyMovedItem(snapshot),
  };
}

module.exports = {
  buildCompactBoardContext,
};
