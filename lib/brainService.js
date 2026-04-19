const { searchFlights, saveFlightsToFile } = require("./flightTools");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BRAIN_MODEL = process.env.BRAIN_MODEL || "gpt-4.1-mini";

function isFlightTask(taskType, userGoal) {
  const text = `${taskType || ""} ${userGoal || ""}`.toLowerCase();
  return /(flight|flights|fare|airline|airport|cheapest|from .* to )/.test(text);
}

async function callBrainModel(input) {
  if (!OPENAI_API_KEY) {
    return {
      handled_by: "brain",
      spoken_summary: "I need a configured OpenAI API key to complete this request.",
      full_response: "Missing OPENAI_API_KEY on backend.",
      missing_info: ["OPENAI_API_KEY"],
      usage: null,
    };
  }

  const systemPrompt = [
    "You are the non-realtime Brain model behind a voice controller.",
    "Keep spoken_summary concise (1-2 sentences).",
    "If critical details are missing, return them in missing_info and ask concise follow-up.",
    "Return strict JSON with keys: spoken_summary, full_response, missing_info.",
  ].join(" ");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: BRAIN_MODEL,
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
              missing_info: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["spoken_summary", "full_response", "missing_info"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
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
      missing_info: [],
    };
  }

  return {
    handled_by: "brain",
    ...parsed,
    usage: data.usage || null,
  };
}

async function delegateToBrain(payload, sessionState) {
  const normalized = {
    task_type: payload?.task_type || "general",
    user_goal: payload?.user_goal || "",
    collected_context: payload?.collected_context || "",
    missing_info: Array.isArray(payload?.missing_info) ? payload.missing_info : [],
    response_mode: payload?.response_mode || "short_answer",
  };

  sessionState.last_task_type = normalized.task_type;
  sessionState.last_user_goal = normalized.user_goal;

  if (isFlightTask(normalized.task_type, normalized.user_goal)) {
    const search = searchFlights(payload);
    if (!search.ok) {
      return {
        handled_by: "brain",
        spoken_summary: "I need date, origin, and destination to search flights.",
        full_response: search.error,
        missing_info: ["origin", "destination", "date"],
        usage: null,
      };
    }

    const save = await saveFlightsToFile({ query: search.query, flights: search.flights });
    return {
      handled_by: "brain",
      spoken_summary: search.count
        ? `I found ${search.count} options and saved the cheapest flights to flights found.txt.`
        : "No matching flights were found in the current dataset. I still updated flights found.txt.",
      full_response: `${search.summary}\n\nSaved: ${save.file_path}`,
      missing_info: [],
      search,
      save,
      usage: null,
    };
  }

  const brainResult = await callBrainModel({
    ...normalized,
    compact_session_state: {
      last_task_type: sessionState.last_task_type,
      last_user_goal: sessionState.last_user_goal,
    },
  });

  if (brainResult.usage) {
    console.log("[brain usage]", brainResult.usage);
  }

  return brainResult;
}

module.exports = {
  delegateToBrain,
};
