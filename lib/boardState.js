const SUPPORTED_OPERATION_TYPES = new Set([
  "create_node",
  "update_node",
  "create_edge",
  "create_group",
  "move_item",
  "emphasize_item",
  "delete_item",
  "undo",
]);

function createBoardState() {
  return {
    version: 0,
    nodes: [],
    edges: [],
    groups: [],
    operation_log: [],
    undo_stack: [],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshotBoard(board) {
  return {
    version: board.version,
    nodes: clone(board.nodes),
    edges: clone(board.edges),
    groups: clone(board.groups),
  };
}

function restoreSnapshot(board, snapshot) {
  board.version = snapshot.version;
  board.nodes = clone(snapshot.nodes);
  board.edges = clone(snapshot.edges);
  board.groups = clone(snapshot.groups);
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function requireOperationType(operation) {
  if (!operation || !SUPPORTED_OPERATION_TYPES.has(operation.type)) {
    throw new Error(`Unsupported board operation: ${operation?.type || "unknown"}`);
  }
}

function upsertById(items, item) {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) {
    items[index] = { ...items[index], ...item };
    return;
  }
  items.push(item);
}

function applyOperation(board, operation) {
  requireOperationType(operation);

  if (operation.type === "create_node") {
    upsertById(board.nodes, {
      id: operation.id || makeId("node"),
      text: String(operation.text || "Untitled thought"),
      x: Number.isFinite(operation.x) ? operation.x : 120,
      y: Number.isFinite(operation.y) ? operation.y : 120,
      group_id: operation.group_id || null,
      emphasis: operation.emphasis || "normal",
      workspace_entry_id: operation.workspace_entry_id || null,
      memory_status: operation.memory_status || "exploratory",
      origin: operation.origin || null,
    });
    return;
  }

  if (operation.type === "update_node") {
    const node = board.nodes.find((item) => item.id === operation.id);
    if (!node) return;
    Object.assign(node, {
      ...("text" in operation ? { text: String(operation.text || "") } : {}),
      ...("group_id" in operation ? { group_id: operation.group_id || null } : {}),
      ...("workspace_entry_id" in operation ? { workspace_entry_id: operation.workspace_entry_id || null } : {}),
      ...("memory_status" in operation ? { memory_status: operation.memory_status || "exploratory" } : {}),
      ...("origin" in operation ? { origin: operation.origin || null } : {}),
    });
    return;
  }

  if (operation.type === "create_edge") {
    if (!operation.from || !operation.to) return;
    upsertById(board.edges, {
      id: operation.id || makeId("edge"),
      from: operation.from,
      to: operation.to,
      label: operation.label || "",
    });
    return;
  }

  if (operation.type === "create_group") {
    upsertById(board.groups, {
      id: operation.id || makeId("group"),
      title: String(operation.title || "Group"),
      node_ids: Array.isArray(operation.node_ids) ? operation.node_ids : [],
    });
    return;
  }

  if (operation.type === "move_item") {
    const item = board.nodes.find((node) => node.id === operation.id);
    if (!item) return;
    if (Number.isFinite(operation.x)) item.x = operation.x;
    if (Number.isFinite(operation.y)) item.y = operation.y;
    return;
  }

  if (operation.type === "emphasize_item") {
    const item = board.nodes.find((node) => node.id === operation.id);
    if (!item) return;
    item.emphasis = operation.emphasis || "primary";
    return;
  }

  if (operation.type === "delete_item") {
    board.nodes = board.nodes.filter((node) => node.id !== operation.id);
    board.edges = board.edges.filter((edge) => edge.id !== operation.id && edge.from !== operation.id && edge.to !== operation.id);
    board.groups = board.groups
      .filter((group) => group.id !== operation.id)
      .map((group) => ({ ...group, node_ids: group.node_ids.filter((id) => id !== operation.id) }));
  }
}

function applyBoardOperations(board, operations = [], metadata = {}) {
  if (!Array.isArray(operations)) {
    throw new Error("board_operations must be an array");
  }

  operations.forEach(requireOperationType);

  const checkpointId = makeId("checkpoint");
  const before = snapshotBoard(board);

  operations.forEach((operation) => {
    applyOperation(board, operation);
    board.version += 1;
    board.operation_log.push({
      ...clone(operation),
      source: metadata.source || "system",
      checkpoint_id: checkpointId,
      applied_at: new Date().toISOString(),
      version: board.version,
    });
  });

  board.undo_stack.push({
    checkpoint_id: checkpointId,
    snapshot: before,
    operation_count: operations.length,
  });

  return {
    ok: true,
    undo_checkpoint_id: checkpointId,
    board_state: getBoardSnapshot(board),
  };
}

function undoLastCheckpoint(board) {
  const checkpoint = board.undo_stack.pop();
  if (!checkpoint) {
    return {
      ok: false,
      error: "Nothing to undo.",
      board_state: getBoardSnapshot(board),
    };
  }

  restoreSnapshot(board, checkpoint.snapshot);
  board.version += 1;
  board.operation_log.push({
    type: "undo",
    checkpoint_id: checkpoint.checkpoint_id,
    source: "user",
    applied_at: new Date().toISOString(),
    version: board.version,
  });

  return {
    ok: true,
    undone_checkpoint_id: checkpoint.checkpoint_id,
    board_state: getBoardSnapshot(board),
  };
}

function getBoardSnapshot(board) {
  return {
    version: board.version,
    nodes: clone(board.nodes),
    edges: clone(board.edges),
    groups: clone(board.groups),
    operation_log: clone(board.operation_log),
    can_undo: board.undo_stack.length > 0,
  };
}

function getSupportedOperationTypes() {
  return Array.from(SUPPORTED_OPERATION_TYPES);
}

module.exports = {
  createBoardState,
  applyBoardOperations,
  undoLastCheckpoint,
  getBoardSnapshot,
  getSupportedOperationTypes,
};
