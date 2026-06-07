const { searchFlights, saveFlightsToFile } = require("./flightTools");
const { routeUserIntent } = require("./intentRouter");
const { applyBoardOperations, getBoardSnapshot } = require("./boardState");
const { validateBoardOperations } = require("./boardOperationValidator");
const { MODEL_ROLES, selectModel } = require("./modelPolicy");
const { buildCompactBoardContext } = require("./boardContext");
const { detectLanguage, getIdeaMapCopy, planWhiteboardOperations } = require("./whiteboardPlannerService");

function recordEvent(options = {}, event = {}) {
  const recorder = options.recorder;
  if (!recorder || typeof recorder.recordEvent !== "function") {
    return null;
  }

  try {
    const result = recorder.recordEvent({
      session_id: options.sessionId || options.session_id || "default",
      trace_id: options.traceId || options.trace_id,
      ...event,
    });

    if (result && typeof result.then === "function") {
      result.catch(() => {});
    }

    return result;
  } catch {
    return null;
  }
}

function isFlightTask(taskType, userGoal) {
  const text = `${taskType || ""} ${userGoal || ""}`.toLowerCase();
  return /(flight|flights|fare|airline|airport|cheapest|from .* to )/.test(text);
}

async function callBrainModel(input, options = {}) {
  const modelSelection = selectModel({
    role: MODEL_ROLES.brain_reasoner,
    complexity: input?.should_use_whiteboard ? "high" : "medium",
    latency_budget: "relaxed",
    artifact_type: input?.target_artifact || input?.artifact_type || "conversation",
  });
  recordEvent(options, {
    category: "model",
    action: "brain",
    status: "started",
    summary: "calling brain model",
    payload: {
      brain_input: input,
      model: modelSelection.model,
      model_role: modelSelection.role,
    },
  });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    recordEvent(options, {
      category: "model",
      action: "brain",
      status: "failed",
      summary: "brain model unavailable",
      payload: {
        brain_input: input,
        model: modelSelection.model,
        model_role: modelSelection.role,
        reason: "Missing OPENAI_API_KEY",
      },
    });
    return {
      handled_by: "brain",
      spoken_summary: "I need a configured OpenAI API key to complete this request.",
      full_response: "Missing OPENAI_API_KEY on backend.",
      reasoning_summary: "The backend cannot call the configured brain model without an API key.",
      board_operations: [],
      undo_checkpoint_id: null,
      missing_info: ["OPENAI_API_KEY"],
      model: modelSelection.model,
      model_role: modelSelection.role,
      usage: null,
    };
  }

  const systemPrompt = [
    "You are the non-realtime Brain model behind a voice controller.",
    "Keep spoken_summary concise (1-2 sentences).",
    "If critical details are missing, return them in missing_info and ask concise follow-up.",
    "Return strict JSON with keys: spoken_summary, full_response, reasoning_summary, missing_info.",
  ].join(" ");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelSelection.model,
      input: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify(input),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "brain_delegate_response",
          schema: {
            type: "object",
            properties: {
              spoken_summary: { type: "string" },
              full_response: { type: "string" },
              reasoning_summary: { type: "string" },
              missing_info: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["spoken_summary", "full_response", "reasoning_summary", "missing_info"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    recordEvent(options, {
      category: "model",
      action: "brain",
      status: "failed",
      summary: "brain model request failed",
      payload: {
        brain_input: input,
        model: modelSelection.model,
        model_role: modelSelection.role,
        error: data?.error?.message || "Brain model request failed",
      },
    });
    throw new Error(data?.error?.message || "Brain model request failed");
  }

  const raw = data.output_text || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      spoken_summary: "I completed the request.",
      full_response: raw,
      reasoning_summary: "The brain returned non-JSON text, so the raw response was preserved.",
      missing_info: [],
    };
  }

  const output = {
    handled_by: "brain",
    ...parsed,
    board_operations: [],
    undo_checkpoint_id: null,
    model: modelSelection.model,
    model_role: modelSelection.role,
    usage: data.usage || null,
  };
  recordEvent(options, {
    category: "model",
    action: "brain",
    status: "completed",
    summary: "brain model completed",
    payload: {
      brain_input: input,
      normalized_output: output,
      model: modelSelection.model,
      model_role: modelSelection.role,
    },
  });
  return output;
}

async function delegateToBrain(payload, sessionState, options = {}) {
  recordEvent(options, {
    category: "brain",
    action: "brain_delegate",
    status: "started",
    summary: "delegating request to brain",
    payload: {
      payload,
    },
  });

  const boardContext = payload?.board_context || buildCompactBoardContext(sessionState.board, {
    selected_item: sessionState.selected_item,
    recently_moved_item: sessionState.recently_moved_item,
  });
  const normalized = payload?.intent_type
    ? { ...payload, board_context: payload.board_context || boardContext }
    : await routeUserIntent({
        user_goal: payload?.user_goal || "",
        collected_context: payload?.collected_context || "",
        missing_info: payload?.missing_info,
      }, {
        board: sessionState.board,
        board_context: boardContext,
        selected_item: sessionState.selected_item,
        recently_moved_item: sessionState.recently_moved_item,
        recorder: options.recorder,
        sessionId: options.sessionId,
        session_id: options.session_id,
        traceId: options.traceId,
        trace_id: options.trace_id,
      });

  sessionState.last_task_type = normalized.intent_type || normalized.task_type;
  sessionState.last_user_goal = normalized.user_goal;

  if (normalized.should_use_whiteboard === true || (normalized.intent_type === "develop_idea_map" && normalized.target_artifact === "idea_map")) {
    recordEvent(options, {
      category: "brain",
      action: "brain_board_path",
      status: "started",
      summary: "brain selected whiteboard path",
      payload: {
        normalized,
      },
    });

    const plan = await planWhiteboardOperations(normalized, sessionState.board, {
      board_context: boardContext,
      recorder: options.recorder,
      sessionId: options.sessionId,
      session_id: options.session_id,
      traceId: options.traceId,
      trace_id: options.trace_id,
    });
    const validation = plan.validation_warnings
      ? { validOperations: plan.board_operations, warnings: plan.validation_warnings }
      : validateBoardOperations(plan.board_operations, sessionState.board, {
      allowDestructive: normalized.allow_destructive_operations === true,
    });
    const boardOperations = validation.validOperations;
    const applied = boardOperations.length
      ? applyBoardOperations(sessionState.board, boardOperations, { source: "ai" })
      : {
          undo_checkpoint_id: null,
          board_state: getBoardSnapshot(sessionState.board),
        };
    const language = detectLanguage(`${normalized.user_goal || ""} ${normalized.known_context || ""}`);
    const copy = getIdeaMapCopy(language);
    const validationWarning = validation.warnings.length
      ? ` Operation validation dropped ${validation.warnings.length} invalid operation(s): ${validation.warnings.join(" ")}`
      : "";
    const result = {
      handled_by: "brain",
      spoken_summary: plan.spoken_summary || copy.spoken,
      full_response: plan.full_response || copy.full,
      reasoning_summary: `${plan.reasoning_summary || copy.reasoning}${validationWarning}`,
      missing_info: plan.missing_info || [],
      board_operations: boardOperations,
      undo_checkpoint_id: applied.undo_checkpoint_id,
      board_state: applied.board_state,
      board_context: plan.board_context || boardContext,
      layout_notes: plan.layout_notes || "",
      model: plan.model,
      model_role: plan.model_role,
      usage: null,
    };
    recordEvent(options, {
      category: "brain",
      action: "brain_board_path",
      status: "completed",
      summary: "brain completed whiteboard path",
      payload: {
        normalized,
        result,
      },
    });
    recordEvent(options, {
      category: "brain",
      action: "brain_delegate",
      status: "completed",
      summary: "completed brain delegation",
      payload: {
        result,
      },
    });
    return result;
  }

  if (isFlightTask(normalized.intent_type || normalized.task_type, normalized.user_goal)) {
    recordEvent(options, {
      category: "brain",
      action: "brain_flight_path",
      status: "started",
      summary: "brain selected flight workflow",
      payload: {
        normalized,
      },
    });

    const search = searchFlights(payload);
    if (!search.ok) {
      const result = {
        handled_by: "brain",
        spoken_summary: "I need date, origin, and destination to search flights.",
        full_response: search.error,
        reasoning_summary: "The flight workflow requires origin, destination, and date before tool execution.",
        board_operations: [],
        undo_checkpoint_id: null,
        missing_info: ["origin", "destination", "date"],
        usage: null,
      };
      recordEvent(options, {
        category: "brain",
        action: "brain_flight_path",
        status: "completed",
        summary: "brain completed flight workflow",
        payload: {
          normalized,
          result,
        },
      });
      recordEvent(options, {
        category: "brain",
        action: "brain_delegate",
        status: "completed",
        summary: "completed brain delegation",
        payload: {
          result,
        },
      });
      return result;
    }

    const save = await saveFlightsToFile({ query: search.query, flights: search.flights });
    const result = {
      handled_by: "brain",
      spoken_summary: search.count
        ? `I found ${search.count} options and saved the cheapest flights to flights found.txt.`
        : "No matching flights were found in the current dataset. I still updated flights found.txt.",
      full_response: `${search.summary}\n\nSaved: ${save.file_path}`,
      reasoning_summary: "The brain used the existing flight workflow and did not change the board.",
      missing_info: [],
      board_operations: [],
      undo_checkpoint_id: null,
      search,
      save,
      usage: null,
    };
    recordEvent(options, {
      category: "brain",
      action: "brain_flight_path",
      status: "completed",
      summary: "brain completed flight workflow",
      payload: {
        normalized,
        result,
      },
    });
    recordEvent(options, {
      category: "brain",
      action: "brain_delegate",
      status: "completed",
      summary: "completed brain delegation",
      payload: {
        result,
      },
    });
    return result;
  }

  const brainResult = await callBrainModel({
    ...normalized,
    compact_session_state: {
      last_task_type: sessionState.last_task_type,
      last_user_goal: sessionState.last_user_goal,
    },
  }, options);

  if (brainResult.usage) {
    console.log("[brain usage]", brainResult.usage);
  }

  recordEvent(options, {
    category: "brain",
    action: "brain_delegate",
    status: "completed",
    summary: "completed brain delegation",
    payload: {
      result: brainResult,
    },
  });
  return brainResult;
}

module.exports = {
  delegateToBrain,
};
