const { proposeWorkspaceUpdate } = require("./workspaceUpdateService");
const {
  applyWorkspaceOperations,
  undoLastWorkspaceCheckpoint,
  getWorkspaceSnapshot,
} = require("./reasoningWorkspace");
const {
  buildCompactWorkspaceContext,
  buildRealtimeWorkspaceBriefing,
} = require("./workspaceContext");
const { generateWorkspaceResponse } = require("./workspaceResponseService");
const { routeUserIntent } = require("./intentRouter");
const { buildWhiteboardCommandFromIntent } = require("./whiteboardCommandService");

const RESPONSE_FAILURE_SUMMARY = "I captured the reasoning update, but I could not complete the deeper analysis yet.";
const CLARIFY_FALLBACK = "I need a little more detail before updating the reasoning workspace.";

function turnIdFor(payload = {}, workspace = {}) {
  if (payload.turn_id) return String(payload.turn_id);
  const version = Number.isFinite(workspace.version) ? workspace.version + 1 : 1;
  return `coordinator-turn-${version}`;
}

function utteranceFor(payload = {}) {
  return payload.user_goal || payload.utterance || "";
}

function buildWorkspaceState(workspace) {
  return {
    workspace_state: getWorkspaceSnapshot(workspace),
    workspace_briefing: buildRealtimeWorkspaceBriefing(workspace),
  };
}

function buildReasoningSyncCommand(workspaceContext, syncReason, overrides = {}) {
  return {
    command_type: "reorganize_artifact",
    artifact_type: "idea_map",
    user_goal: "Synchronize the board with updated committed reasoning.",
    change_description: "Reflect authoritative workspace changes.",
    target_confidence: 1,
    workspace_context: workspaceContext,
    sync_reason: syncReason,
    ...overrides,
  };
}

function hasCommittedMutation(operations = []) {
  return operations.some((operation) => operation.type !== "update_working_memory");
}

async function coordinateUndo(update, state) {
  const undone = undoLastWorkspaceCheckpoint(state.workspace);
  const workspaceContext = buildCompactWorkspaceContext(state.workspace);
  const workspaceState = buildWorkspaceState(state.workspace);
  const spokenSummary = undone.ok
    ? update.spoken_commit_notice || "I undid the last reasoning update."
    : undone.error || "There was no reasoning update to undo.";

  return {
    handled_by: "workspace",
    action: "undo",
    spoken_summary: spokenSummary,
    ...workspaceState,
    board_sync_required: undone.ok,
    board_command: undone.ok
      ? buildReasoningSyncCommand(workspaceContext, "reasoning_undo")
      : null,
  };
}

async function coordinateClarify(update, state) {
  return {
    handled_by: "turn_coordinator",
    action: "clarify",
    spoken_summary: update.needs_clarification || CLARIFY_FALLBACK,
    ...buildWorkspaceState(state.workspace),
    board_sync_required: false,
    board_command: null,
  };
}

async function generateGroundedResponse(utterance, workspaceContext, options) {
  try {
    const response = await generateWorkspaceResponse({
      utterance,
      workspace_context: workspaceContext,
    }, options);
    return {
      response,
      response_error: null,
    };
  } catch (error) {
    return {
      response: {
        spoken_summary: RESPONSE_FAILURE_SUMMARY,
        full_response: "",
        reasoning_summary: "",
        uncertainties: [],
        next_examination: "",
      },
      response_error: error.message || String(error),
    };
  }
}

async function routeAndBuildBoardCommand(payload, state, workspaceContext, update, options) {
  const briefing = buildRealtimeWorkspaceBriefing(state.workspace);

  try {
    const intent = await routeUserIntent({
      ...payload,
      user_goal: utteranceFor(payload),
      collected_context: briefing,
    }, {
      ...options,
      decisionProvider: options.routeProvider,
      board: state.board,
      selected_item: state.selected_item,
      recently_moved_item: state.recently_moved_item,
    });

    if (intent.should_use_whiteboard) {
      return {
        intent,
        board_command: {
          ...buildWhiteboardCommandFromIntent(intent),
          workspace_context: workspaceContext,
          sync_reason: "reasoning_turn",
        },
        board_sync_error: null,
      };
    }

    if (hasCommittedMutation(update.operations)) {
      return {
        intent,
        board_command: buildReasoningSyncCommand(workspaceContext, "committed_workspace_change"),
        board_sync_error: null,
      };
    }

    return {
      intent,
      board_command: null,
      board_sync_error: null,
    };
  } catch (error) {
    const boardCommand = hasCommittedMutation(update.operations)
      ? buildReasoningSyncCommand(workspaceContext, "committed_workspace_change")
      : null;

    return {
      intent: null,
      board_command: boardCommand,
      board_sync_error: error.message || String(error),
    };
  }
}

async function coordinateReasoningTurn(payload = {}, state, options = {}) {
  if (!state?.workspace) {
    throw new Error("Reasoning coordinator requires state.workspace.");
  }

  const turn_id = turnIdFor(payload, state.workspace);
  const utterance = utteranceFor(payload);
  const update = await proposeWorkspaceUpdate({
    ...payload,
    utterance,
    turn_id,
  }, state.workspace, options);

  if (update.action === "undo") {
    return coordinateUndo(update, state);
  }

  if (update.action === "clarify") {
    return coordinateClarify(update, state);
  }

  const applied = applyWorkspaceOperations(state.workspace, update.operations, {
    source: "coordinator",
    turn_id,
  });
  const workspaceContext = buildCompactWorkspaceContext(state.workspace);
  const { response, response_error } = await generateGroundedResponse(utterance, workspaceContext, options);
  const routed = await routeAndBuildBoardCommand(payload, state, workspaceContext, update, options);

  return {
    handled_by: "turn_coordinator",
    action: "update",
    ...response,
    response_error,
    spoken_commit_notice: update.spoken_commit_notice,
    workspace_checkpoint_id: applied.undo_checkpoint_id,
    ...buildWorkspaceState(state.workspace),
    intent: routed.intent,
    board_command: routed.board_command,
    board_sync_required: Boolean(routed.board_command),
    board_sync_error: routed.board_sync_error,
  };
}

module.exports = {
  coordinateReasoningTurn,
};
