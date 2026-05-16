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

const CREATE_OPERATION_TYPES = new Set(["create_node", "create_edge", "create_group"]);
const DESTRUCTIVE_OPERATION_TYPES = new Set(["delete_item", "undo"]);

function isStringId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function collectExistingIds(board = {}) {
  return new Set([
    ...(board.nodes || []).map((node) => node.id),
    ...(board.edges || []).map((edge) => edge.id),
    ...(board.groups || []).map((group) => group.id),
  ].filter(isStringId));
}

function collectExistingNodeIds(board = {}) {
  return new Set((board.nodes || []).map((node) => node.id).filter(isStringId));
}

function collectBatchNodeIds(operations = []) {
  return new Set(
    operations
      .filter((operation) => operation?.type === "create_node" && isStringId(operation.id))
      .map((operation) => operation.id)
  );
}

function coordinatesAreFinite(operation) {
  if (operation.type === "create_node") {
    return Number.isFinite(operation.x) && Number.isFinite(operation.y);
  }
  if (operation.type === "move_item") {
    return Number.isFinite(operation.x) && Number.isFinite(operation.y);
  }
  return true;
}

function validateBoardOperations(operations = [], board = {}, options = {}) {
  if (!Array.isArray(operations)) {
    return {
      validOperations: [],
      warnings: ["Dropped operation batch because board_operations must be an array."],
    };
  }

  const existingIds = collectExistingIds(board);
  const knownNodeIds = collectExistingNodeIds(board);
  const allBatchNodeIds = collectBatchNodeIds(operations);
  const batchCreatedIds = new Set();
  const warnings = [];
  const validOperations = [];

  operations.forEach((operation, index) => {
    const label = `operation ${index + 1}`;

    if (!operation || typeof operation !== "object") {
      warnings.push(`Dropped ${label}: operation must be an object.`);
      return;
    }

    if (!SUPPORTED_OPERATION_TYPES.has(operation.type)) {
      warnings.push(`Dropped ${label}: unsupported operation type "${operation.type}".`);
      return;
    }

    if (DESTRUCTIVE_OPERATION_TYPES.has(operation.type) && !options.allowDestructive) {
      warnings.push(`Dropped ${label}: destructive operation "${operation.type}" was not explicitly allowed.`);
      return;
    }

    if (operation.type !== "undo" && !isStringId(operation.id)) {
      warnings.push(`Dropped ${label}: id must be a non-empty string.`);
      return;
    }

    if (CREATE_OPERATION_TYPES.has(operation.type)) {
      if (existingIds.has(operation.id) || batchCreatedIds.has(operation.id)) {
        warnings.push(`Dropped ${label}: duplicate id "${operation.id}".`);
        return;
      }
    }

    if (!coordinatesAreFinite(operation)) {
      warnings.push(`Dropped ${label}: operation must use finite coordinates.`);
      return;
    }

    if (operation.type === "create_edge") {
      if (!isStringId(operation.from) || !isStringId(operation.to)) {
        warnings.push(`Dropped ${label}: create_edge.from and create_edge.to must be string ids.`);
        return;
      }
      if (!knownNodeIds.has(operation.from) || !knownNodeIds.has(operation.to)) {
        warnings.push(`Dropped ${label}: create_edge has missing node references.`);
        return;
      }
    }

    if (operation.type === "create_group") {
      const nodeIds = Array.isArray(operation.node_ids) ? operation.node_ids : [];
      const invalidNodeIds = nodeIds.filter((id) => !isStringId(id) || (!knownNodeIds.has(id) && !allBatchNodeIds.has(id)));
      if (invalidNodeIds.length) {
        warnings.push(`Dropped ${label}: create_group has invalid node_ids.`);
        return;
      }
    }

    validOperations.push(operation);

    if (CREATE_OPERATION_TYPES.has(operation.type)) {
      existingIds.add(operation.id);
      batchCreatedIds.add(operation.id);
    }
    if (operation.type === "create_node") {
      knownNodeIds.add(operation.id);
    }
  });

  return {
    validOperations,
    warnings,
  };
}

module.exports = {
  validateBoardOperations,
};
