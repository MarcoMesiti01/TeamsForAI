const { getBoardSnapshot } = require("./boardState");
const { validateBoardOperations } = require("./boardOperationValidator");
const { planWhiteboardOperations } = require("./whiteboardPlannerService");

const COMMAND_TYPES = new Set([
  "create_artifact",
  "modify_item",
  "move_item",
  "connect_items",
  "group_items",
  "reorganize_artifact",
  "emphasize_item",
  "delete_item",
  "replace_artifact",
]);

const DESTRUCTIVE_COMMAND_TYPES = new Set(["delete_item", "replace_artifact"]);

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeConfidence(value, fallback = 0.7) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value && Object.prototype.toString.call(value) === "[object Object]");
}

function normalizeSyncReason(value, workspaceContext) {
  const explicitReason = normalizeText(value);
  if (explicitReason) return explicitReason;
  return workspaceContext ? "workspace_update" : null;
}

function normalizeWhiteboardCommand(input = {}) {
  const commandType = normalizeText(input.command_type || input.type || "create_artifact");
  if (!COMMAND_TYPES.has(commandType)) {
    throw new Error(`Unsupported whiteboard command: ${commandType || "unknown"}`);
  }

  const targetSelector = input.target_selector && typeof input.target_selector === "object"
    ? input.target_selector
    : {};
  const workspaceContext = isPlainObject(input.workspace_context)
    ? clone(input.workspace_context)
    : null;

  return {
    command_type: commandType,
    artifact_type: normalizeText(input.artifact_type || input.target_artifact || "idea_map"),
    user_goal: normalizeText(input.user_goal || input.goal || input.change_description),
    target_selector: { ...targetSelector },
    target_confidence: normalizeConfidence(input.target_confidence, commandType === "create_artifact" ? 1 : 0.7),
    change_description: normalizeText(input.change_description || input.visual_summary_goal || input.user_goal),
    constraints: input.constraints && typeof input.constraints === "object" ? { ...input.constraints } : {},
    allow_destructive: input.allow_destructive === true || input.allow_destructive_operations === true,
    board_strategy: normalizeText(input.board_strategy || (commandType === "create_artifact" ? "create_new_group" : "refine_existing")),
    visual_summary_goal: normalizeText(input.visual_summary_goal || input.change_description || input.user_goal),
    workspace_context: workspaceContext,
    sync_reason: normalizeSyncReason(input.sync_reason, workspaceContext),
    expected_workspace_version: Number.isFinite(input.expected_workspace_version) ? input.expected_workspace_version : null,
  };
}

function commandTypeFromGoal(goal, fallback = "create_artifact") {
  const text = normalizeText(goal).toLowerCase();
  if (/\b(connect|link|relate|join)\b|collega|connetti/.test(text)) return "connect_items";
  if (/\b(delete|remove|erase)\b|elimina|rimuovi/.test(text)) return "delete_item";
  if (/\b(move|place|position)\b|sposta|posiziona/.test(text)) return "move_item";
  if (/\b(group|cluster)\b|raggruppa/.test(text)) return "group_items";
  if (/\b(emphasize|highlight|prioritize)\b|evidenzia/.test(text)) return "emphasize_item";
  if (/\b(modify|update|change|rename|edit|refine|improve|add)\b|modifica|aggiorna|cambia|raffina|migliora|aggiungi/.test(text)) {
    return "modify_item";
  }
  return fallback;
}

function buildWhiteboardCommandFromIntent(intent = {}) {
  const commandType = intent.board_command?.command_type
    || commandTypeFromGoal(intent.user_goal, intent.should_use_whiteboard ? "create_artifact" : "modify_item");

  return normalizeWhiteboardCommand({
    command_type: commandType,
    artifact_type: intent.artifact_type || intent.target_artifact || "idea_map",
    user_goal: intent.user_goal || "",
    target_selector: intent.board_command?.target_selector || {
      text: intent.board_command?.target_text || "",
      selected: /\b(this|that|selected|current)\b|questo|selezionato/i.test(intent.user_goal || ""),
    },
    target_confidence: intent.board_command?.target_confidence ?? intent.confidence ?? 0.7,
    change_description: intent.board_command?.change_description || intent.visual_summary_goal || intent.user_goal || "",
    constraints: intent.board_command?.constraints || {},
    allow_destructive: intent.allow_destructive_operations === true || intent.board_command?.allow_destructive === true,
    board_strategy: intent.board_strategy || "create_new_group",
    visual_summary_goal: intent.visual_summary_goal || intent.user_goal || "",
    workspace_context: intent.workspace_context || intent.board_command?.workspace_context || null,
    sync_reason: intent.sync_reason || intent.board_command?.sync_reason,
    expected_workspace_version: intent.expected_workspace_version ?? intent.board_command?.expected_workspace_version,
  });
}

function textIncludes(haystack, needle) {
  const normalizedHaystack = normalizeText(haystack).toLowerCase();
  const normalizedNeedle = normalizeText(needle).toLowerCase();
  return Boolean(normalizedHaystack && normalizedNeedle && normalizedHaystack.includes(normalizedNeedle));
}

function collectItems(board = {}) {
  return {
    nodes: board.nodes || [],
    edges: board.edges || [],
    groups: board.groups || [],
  };
}

function findNodeByText(board, text) {
  const { nodes } = collectItems(board);
  return nodes.find((node) => textIncludes(node.text, text));
}

function findGroupByTitle(board, title) {
  const { groups } = collectItems(board);
  return groups.find((group) => textIncludes(group.title, title));
}

function findItemById(board, id) {
  const { nodes, edges, groups } = collectItems(board);
  return [...nodes, ...edges, ...groups].find((item) => item.id === id);
}

function resolveSingleTarget(selector, board, context = {}) {
  if (selector.id) return findItemById(board, selector.id);
  if (selector.selected && context.selected_item?.id) return findItemById(board, context.selected_item.id);
  if (selector.recent && context.recently_moved_item?.id) return findItemById(board, context.recently_moved_item.id);
  if (selector.text) return findNodeByText(board, selector.text);
  if (selector.title) return findNodeByText(board, selector.title) || findGroupByTitle(board, selector.title);
  if (selector.group_title) return findGroupByTitle(board, selector.group_title);
  return null;
}

function resolveSemanticTarget(command, board) {
  const words = normalizeText(`${command.user_goal} ${command.change_description}`)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
  if (!words.length) return null;

  return (board.nodes || []).find((node) => {
    const text = normalizeText(node.text).toLowerCase();
    return words.some((word) => text.includes(word));
  });
}

function resolveCommandTargets(command, board = {}, context = {}) {
  const normalized = normalizeWhiteboardCommand(command);
  const selector = normalized.target_selector || {};
  const targets = [];

  const directTarget = resolveSingleTarget(selector, board, context) || resolveSemanticTarget(normalized, board);
  if (directTarget) targets.push(directTarget);

  const from = selector.from_id
    ? findItemById(board, selector.from_id)
    : selector.from_text
      ? findNodeByText(board, selector.from_text)
      : null;
  const to = selector.to_id
    ? findItemById(board, selector.to_id)
    : selector.to_text
      ? findNodeByText(board, selector.to_text)
      : null;

  return {
    targets,
    from: from || null,
    to: to || null,
    confidence: normalized.target_confidence,
  };
}

function makeId(prefix, text) {
  const slug = normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 28) || "item";
  return `${prefix}-${Date.now().toString(36)}-${slug}`;
}

async function planOperationsForCommand(commandInput, board = {}, options = {}) {
  const command = normalizeWhiteboardCommand(commandInput);
  const targetResolution = resolveCommandTargets(command, board, options);
  const isDestructive = DESTRUCTIVE_COMMAND_TYPES.has(command.command_type);

  if (isDestructive && (!command.allow_destructive || command.target_confidence < 0.8)) {
    return {
      status: "needs_clarification",
      spoken_summary: "I need to know exactly which item to change before making a destructive board edit.",
      reasoning_summary: "Destructive whiteboard commands require explicit permission and high target confidence.",
      board_operations: [],
      warnings: ["Destructive command blocked because target confidence or permission was insufficient."],
      target_resolution: targetResolution,
    };
  }

  if (command.command_type === "create_artifact" || command.command_type === "reorganize_artifact" || command.command_type === "replace_artifact") {
    const plan = await planWhiteboardOperations({
      intent_type: "develop_idea_map",
      user_goal: command.user_goal,
      artifact_type: command.artifact_type,
      target_artifact: command.artifact_type,
      should_use_whiteboard: true,
      board_strategy: command.board_strategy,
      visual_summary_goal: command.visual_summary_goal,
      allow_destructive_operations: command.allow_destructive,
      known_context: command.change_description,
      workspace_context: command.workspace_context,
      sync_reason: command.sync_reason,
    }, board, options.plannerOptions || {});

    return {
      status: "completed",
      spoken_summary: plan.spoken_summary,
      reasoning_summary: plan.reasoning_summary,
      board_operations: plan.board_operations,
      warnings: plan.validation_warnings || [],
      target_resolution: targetResolution,
      layout_notes: plan.layout_notes,
      model: plan.model,
      model_role: plan.model_role,
    };
  }

  const operations = [];
  const primaryTarget = targetResolution.targets[0];

  if (command.command_type === "modify_item") {
    if (!primaryTarget?.id || !("text" in primaryTarget)) {
      return {
        status: "needs_clarification",
        spoken_summary: "I could not identify which board item to modify.",
        reasoning_summary: "No node target resolved for modify_item.",
        board_operations: [],
        warnings: ["No target node resolved."],
        target_resolution: targetResolution,
      };
    }
    operations.push({ type: "update_node", id: primaryTarget.id, text: command.change_description || command.user_goal });
  }

  if (command.command_type === "move_item") {
    if (!primaryTarget?.id || !Number.isFinite(command.constraints.x) || !Number.isFinite(command.constraints.y)) {
      return {
        status: "needs_clarification",
        spoken_summary: "I need a clear item and destination before moving it.",
        reasoning_summary: "move_item requires a resolved target and finite coordinates.",
        board_operations: [],
        warnings: ["Move command lacked target or coordinates."],
        target_resolution: targetResolution,
      };
    }
    operations.push({ type: "move_item", id: primaryTarget.id, x: command.constraints.x, y: command.constraints.y });
  }

  if (command.command_type === "connect_items") {
    if (!targetResolution.from?.id || !targetResolution.to?.id) {
      return {
        status: "needs_clarification",
        spoken_summary: "I need two clear board items to connect.",
        reasoning_summary: "connect_items requires two resolved node targets.",
        board_operations: [],
        warnings: ["Connection command lacked endpoints."],
        target_resolution: targetResolution,
      };
    }
    operations.push({
      type: "create_edge",
      id: makeId("edge", `${targetResolution.from.id}-${targetResolution.to.id}`),
      from: targetResolution.from.id,
      to: targetResolution.to.id,
      label: command.change_description || "relates to",
    });
  }

  if (command.command_type === "group_items") {
    const nodeIds = targetResolution.targets
      .filter((target) => target && "text" in target)
      .map((target) => target.id);
    if (!nodeIds.length) {
      return {
        status: "needs_clarification",
        spoken_summary: "I need clear board items to group.",
        reasoning_summary: "group_items requires one or more resolved node targets.",
        board_operations: [],
        warnings: ["Group command lacked node targets."],
        target_resolution: targetResolution,
      };
    }
    operations.push({
      type: "create_group",
      id: makeId("group", command.change_description || command.user_goal),
      title: command.change_description || command.user_goal || "Group",
      node_ids: nodeIds,
    });
  }

  if (command.command_type === "emphasize_item") {
    if (!primaryTarget?.id) {
      return {
        status: "needs_clarification",
        spoken_summary: "I could not identify which board item to emphasize.",
        reasoning_summary: "emphasize_item requires a resolved target.",
        board_operations: [],
        warnings: ["Emphasis command lacked target."],
        target_resolution: targetResolution,
      };
    }
    operations.push({ type: "emphasize_item", id: primaryTarget.id, emphasis: command.constraints.emphasis || "primary" });
  }

  if (command.command_type === "delete_item") {
    if (!primaryTarget?.id) {
      return {
        status: "needs_clarification",
        spoken_summary: "I could not identify which board item to delete.",
        reasoning_summary: "delete_item requires a resolved target.",
        board_operations: [],
        warnings: ["Delete command lacked target."],
        target_resolution: targetResolution,
      };
    }
    operations.push({ type: "delete_item", id: primaryTarget.id });
  }

  const validation = validateBoardOperations(operations, board, {
    allowDestructive: command.allow_destructive,
  });

  return {
    status: validation.validOperations.length || !operations.length ? "completed" : "failed",
    spoken_summary: validation.validOperations.length ? "I updated the board." : "I could not safely update the board.",
    reasoning_summary: "Whiteboard command was resolved into raw board operations.",
    board_operations: validation.validOperations,
    warnings: validation.warnings,
    target_resolution: targetResolution,
    board_snapshot: getBoardSnapshot(board),
  };
}

module.exports = {
  COMMAND_TYPES,
  normalizeWhiteboardCommand,
  buildWhiteboardCommandFromIntent,
  resolveCommandTargets,
  planOperationsForCommand,
};
