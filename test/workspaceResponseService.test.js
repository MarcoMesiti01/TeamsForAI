const test = require("node:test");
const assert = require("node:assert/strict");

const {
  generateWorkspaceResponse,
  normalizeResponse,
} = require("../lib/workspaceResponseService");

function createInput() {
  return {
    turn_id: "turn-9",
    utterance: "Which rollout option is best now?",
    workspace_context: {
      version: 4,
      working_memory: {
        summary: "Comparing rollout options",
        current_topic: "Launch rollout",
        candidate_options: ["Canary", "Blue-green"],
        provisional_observations: ["Canary may lower blast radius"],
        unresolved_references: ["Deployment window"],
      },
      active_entries: {
        problem: [],
        objectives: [{
          id: "objective-1",
          content: "Reduce rollout risk",
          origin: "user_stated",
          source_turn_id: "turn-1",
        }],
        constraints: [],
        assumptions: [],
        options: [{
          id: "option-1",
          content: "Use canary rollout",
          origin: "user_stated",
          source_turn_id: "turn-2",
        }],
        criteria: [],
        decisions: [],
        open_questions: [],
      },
      recent_changes: [],
      can_undo: true,
    },
  };
}

test("injected responseProvider receives unchanged utterance and workspace context and normalizes output", async () => {
  const input = createInput();
  const before = JSON.stringify(input);
  let providerInput;

  const result = await generateWorkspaceResponse(input, {
    responseProvider: async (received) => {
      providerInput = received;
      return {
        spoken_summary: "Canary currently looks best.",
        full_response: "The committed objective is reducing rollout risk, and canary is the committed option.",
        reasoning_summary: "Grounded in objective-1 and option-1.",
        uncertainties: ["Deployment window is unresolved."],
        next_examination: "Check deployment timing.",
      };
    },
  });

  assert.notEqual(providerInput, input);
  assert.equal(providerInput.utterance, input.utterance);
  assert.deepEqual(providerInput.workspace_context, input.workspace_context);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(result, {
    spoken_summary: "Canary currently looks best.",
    full_response: "The committed objective is reducing rollout risk, and canary is the committed option.",
    reasoning_summary: "Grounded in objective-1 and option-1.",
    uncertainties: ["Deployment window is unresolved."],
    next_examination: "Check deployment timing.",
  });
});

test("normalizeResponse coerces missing and malformed fields safely", () => {
  assert.deepEqual(normalizeResponse({
    spoken_summary: 42,
    full_response: null,
    reasoning_summary: false,
    uncertainties: ["known", 7, null],
    next_examination: undefined,
  }), {
    spoken_summary: "42",
    full_response: "",
    reasoning_summary: "false",
    uncertainties: ["known", "7", "null"],
    next_examination: "",
  });

  assert.deepEqual(normalizeResponse({
    uncertainties: "not an array",
  }), {
    spoken_summary: "",
    full_response: "",
    reasoning_summary: "",
    uncertainties: [],
    next_examination: "",
  });

  assert.deepEqual(normalizeResponse(), {
    spoken_summary: "",
    full_response: "",
    reasoning_summary: "",
    uncertainties: [],
    next_examination: "",
  });
});

test("no-key fallback is conservative and does not claim deeper reasoning", async () => {
  const result = await generateWorkspaceResponse(createInput(), { apiKey: "" });

  assert.deepEqual(result, {
    spoken_summary: "I captured the current reasoning context, but deeper analysis requires an API connection.",
    full_response: "Workspace state was updated; grounded reasoning is unavailable without an API key.",
    reasoning_summary: "No model response was generated.",
    uncertainties: [],
    next_examination: "",
  });
});

test("API path uses fetchImpl, default brain model, bearer auth, strict JSON schema, prompt guidance, and parses output_text", async () => {
  const previousModel = process.env.BRAIN_MODEL;
  process.env.BRAIN_MODEL = "test-brain-model";
  let requestUrl;
  let requestOptions;

  try {
    const result = await generateWorkspaceResponse(createInput(), {
      apiKey: "test-key",
      fetchImpl: async (url, options) => {
        requestUrl = url;
        requestOptions = options;
        return {
          ok: true,
          async json() {
            return {
              output_text: JSON.stringify({
                spoken_summary: "Canary is the grounded front-runner.",
                full_response: "Canary best matches the committed risk-reduction objective.",
                reasoning_summary: "Used committed objective and option entries.",
                uncertainties: ["Deployment window remains open."],
                next_examination: "Validate deployment window.",
              }),
            };
          },
        };
      },
    });

    const body = JSON.parse(requestOptions.body);
    const systemPrompt = body.input[0].content;
    const userInput = JSON.parse(body.input[1].content);

    assert.equal(requestUrl, "https://api.openai.com/v1/responses");
    assert.equal(requestOptions.method, "POST");
    assert.equal(requestOptions.headers.Authorization, "Bearer test-key");
    assert.equal(requestOptions.headers["Content-Type"], "application/json");
    assert.equal(body.model, "test-brain-model");
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.name, "workspace_reasoning_response");
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(body.text.format.schema.required, [
      "spoken_summary",
      "full_response",
      "reasoning_summary",
      "uncertainties",
      "next_examination",
    ]);
    assert.equal(body.text.format.schema.additionalProperties, false);
    assert.deepEqual(userInput.workspace_context, createInput().workspace_context);
    assert.match(systemPrompt, /committed workspace entries/i);
    assert.match(systemPrompt, /working memory/i);
    assert.match(systemPrompt, /uncertainties/i);
    assert.match(systemPrompt, /avoid inventing a decision/i);
    assert.match(systemPrompt, /spoken_summary.*voice-ready/i);
    assert.equal(result.spoken_summary, "Canary is the grounded front-runner.");
    assert.deepEqual(result.uncertainties, ["Deployment window remains open."]);
  } finally {
    if (previousModel === undefined) {
      delete process.env.BRAIN_MODEL;
    } else {
      process.env.BRAIN_MODEL = previousModel;
    }
  }
});

test("API path honors explicit model and parses current Responses output content shape", async () => {
  let requestOptions;
  const result = await generateWorkspaceResponse(createInput(), {
    apiKey: "test-key",
    model: "explicit-reasoning-model",
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return {
        ok: true,
        async json() {
          return {
            output: [{
              content: [{
                type: "output_text",
                text: JSON.stringify({
                  spoken_summary: "Blue-green needs more evidence.",
                  full_response: "The committed workspace has no decision yet.",
                  reasoning_summary: "No decision entry exists.",
                  uncertainties: [],
                  next_examination: "Compare rollback criteria.",
                }),
              }],
            }],
          };
        },
      };
    },
  });

  assert.equal(JSON.parse(requestOptions.body).model, "explicit-reasoning-model");
  assert.equal(result.full_response, "The committed workspace has no decision yet.");
});

test("non-ok API response throws useful error", async () => {
  await assert.rejects(
    () => generateWorkspaceResponse(createInput(), {
      apiKey: "test-key",
      fetchImpl: async () => ({
        ok: false,
        async json() {
          return { error: { message: "Bad reasoning request" } };
        },
      }),
    }),
    /Bad reasoning request/
  );
});

test("provider output and input mutation isolation keeps returned arrays independent", async () => {
  const input = createInput();
  const providerOutput = {
    spoken_summary: "Summary",
    full_response: "Full",
    reasoning_summary: "Reasoning",
    uncertainties: ["Initial uncertainty"],
    next_examination: "Next",
  };

  const result = await generateWorkspaceResponse(input, {
    responseProvider: async (received) => {
      received.workspace_context.active_entries.objectives[0].content = "Mutated inside provider";
      return providerOutput;
    },
  });

  result.uncertainties.push("Returned mutation");

  assert.equal(input.workspace_context.active_entries.objectives[0].content, "Reduce rollout risk");
  assert.deepEqual(providerOutput.uncertainties, ["Initial uncertainty"]);
  assert.deepEqual(normalizeResponse(providerOutput).uncertainties, ["Initial uncertainty"]);
});
