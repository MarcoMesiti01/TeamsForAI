const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createReasoningWorkspace,
  applyWorkspaceOperations,
  getWorkspaceSnapshot,
} = require("../lib/reasoningWorkspace");
const {
  proposeWorkspaceUpdate,
  normalizeUpdate,
} = require("../lib/workspaceUpdateService");

function createWorkspace() {
  const workspace = createReasoningWorkspace();
  applyWorkspaceOperations(workspace, [
    {
      type: "update_working_memory",
      summary: "Choosing a launch plan",
      current_topic: "Launch plan",
    },
    {
      type: "add_entry",
      id: "objective-1",
      category: "objectives",
      content: "Reduce rollout risk",
      origin: "user_stated",
      source_turn_id: "turn-1",
    },
  ], { source: "test", turn_id: "turn-1" });
  return workspace;
}

test("injected updateProvider can propose working memory plus committed entries with provenance", async () => {
  const workspace = createWorkspace();
  const result = await proposeWorkspaceUpdate({
    turn_id: "turn-2",
    utterance: "We should use a canary rollout because it lowers blast radius.",
  }, workspace, {
    updateProvider: async () => ({
      action: "update",
      operations: [
        {
          type: "update_working_memory",
          summary: "Considering canary rollout",
          current_topic: "Canary rollout",
        },
        {
          type: "add_entry",
          id: "option-1",
          category: "options",
          content: "Use a canary rollout",
          origin: "user_stated",
          source_turn_id: "turn-2",
        },
        {
          type: "add_entry",
          id: "assumption-1",
          category: "assumptions",
          content: "Lower blast radius reduces launch risk",
          origin: "ai_inferred",
          source_turn_id: "turn-2",
        },
      ],
      spoken_commit_notice: "I captured canary rollout as an option.",
    }),
  });

  assert.equal(result.action, "update");
  assert.equal(result.spoken_commit_notice, "I captured canary rollout as an option.");
  assert.equal(result.needs_clarification, "");
  assert.deepEqual(result.operations, [
    {
      type: "update_working_memory",
      summary: "Considering canary rollout",
      current_topic: "Canary rollout",
    },
    {
      type: "add_entry",
      id: "option-1",
      category: "options",
      content: "Use a canary rollout",
      origin: "user_stated",
      source_turn_id: "turn-2",
    },
    {
      type: "add_entry",
      id: "assumption-1",
      category: "assumptions",
      content: "Lower blast radius reduces launch risk",
      origin: "ai_inferred",
      source_turn_id: "turn-2",
    },
  ]);
});

test("undo utterance returns undo action and does not call provider", async () => {
  let providerCalled = false;
  const result = await proposeWorkspaceUpdate({
    utterance: "Undo the last reasoning.",
  }, createWorkspace(), {
    updateProvider: async () => {
      providerCalled = true;
      return { action: "update" };
    },
  });

  assert.equal(providerCalled, false);
  assert.deepEqual(result, {
    action: "undo",
    operations: [],
    spoken_commit_notice: "I will undo the last reasoning update.",
    needs_clarification: "",
  });
});

test("no-key fallback updates only working memory and does not invent committed knowledge", async () => {
  const utterance = "Let's compare canary and blue-green before choosing.";
  const result = await proposeWorkspaceUpdate({
    user_goal: `  ${utterance}  `,
  }, createWorkspace(), {
    apiKey: "",
  });

  assert.equal(result.action, "update");
  assert.equal(result.spoken_commit_notice, "");
  assert.equal(result.needs_clarification, "");
  assert.deepEqual(result.operations, [
    {
      type: "update_working_memory",
      summary: utterance,
      current_topic: utterance.slice(0, 80),
    },
  ]);
});

test("empty utterance throws", async () => {
  await assert.rejects(
    () => proposeWorkspaceUpdate({ utterance: "   " }, createWorkspace(), { apiKey: "" }),
    /utterance is required/i
  );
});

test("provider input includes compact workspace context and spoken_context", async () => {
  const workspace = createWorkspace();
  const before = getWorkspaceSnapshot(workspace);
  let providerInput;

  await proposeWorkspaceUpdate({
    turn_id: "turn-7",
    utterance: "The launch plan should prioritize low operational risk.",
    spoken_context: "We were discussing deployment options.",
  }, workspace, {
    updateProvider: async (input) => {
      providerInput = input;
      return { action: "clarify", needs_clarification: "Which option?" };
    },
  });

  assert.equal(providerInput.turn_id, "turn-7");
  assert.equal(providerInput.utterance, "The launch plan should prioritize low operational risk.");
  assert.equal(providerInput.spoken_context, "We were discussing deployment options.");
  assert.equal(providerInput.workspace.version, before.version);
  assert.equal(providerInput.workspace.working_memory.summary, "Choosing a launch plan");
  assert.equal(providerInput.workspace.active_entries.objectives[0].content, "Reduce rollout risk");
  assert.deepEqual(getWorkspaceSnapshot(workspace), before);
});

test("normalizeUpdate handles malformed provider results safely", () => {
  assert.deepEqual(normalizeUpdate({
    action: "apply_everything",
    operations: "not an array",
    spoken_commit_notice: 42,
    needs_clarification: null,
  }), {
    action: "clarify",
    operations: [],
    spoken_commit_notice: "42",
    needs_clarification: "",
  });

  assert.deepEqual(normalizeUpdate(), {
    action: "clarify",
    operations: [],
    spoken_commit_notice: "",
    needs_clarification: "",
  });
});

test("normalizeUpdate rejects invalid operation batches fail closed", () => {
  const invalidBatches = [
    {
      reason: "unsupported operation type",
      operations: [{ type: "rewrite_everything", summary: "Bad" }],
    },
    {
      reason: "unsupported category",
      operations: [{
        type: "add_entry",
        id: "entry-1",
        category: "roadmap",
        content: "Ship the beta first",
        origin: "user_stated",
        source_turn_id: "turn-1",
      }],
    },
    {
      reason: "missing provenance",
      operations: [{
        type: "add_entry",
        id: "entry-1",
        category: "decisions",
        content: "Ship the beta first",
        source_turn_id: "turn-1",
      }],
    },
    {
      reason: "malformed id",
      operations: [{
        type: "correct_entry",
        id: "decision-1",
        replacement_id: " ",
        category: "decisions",
        content: "Ship the beta first",
        origin: "user_stated",
        source_turn_id: "turn-1",
      }],
    },
  ];

  invalidBatches.forEach(({ reason, operations }) => {
    assert.deepEqual(normalizeUpdate({
      action: "update",
      operations,
      spoken_commit_notice: "Saved.",
      needs_clarification: "",
    }), {
      action: "clarify",
      operations: [],
      spoken_commit_notice: "Saved.",
      needs_clarification: "",
    }, reason);
  });
});

test("normalizeUpdate clones accepted operations", () => {
  const providerOutput = {
    action: "update",
    operations: [{
      type: "update_working_memory",
      summary: "Compare rollout plans",
      candidate_options: ["Canary"],
    }],
  };

  const first = normalizeUpdate(providerOutput);
  providerOutput.operations[0].summary = "Mutated provider output";
  providerOutput.operations[0].candidate_options.push("Blue-green");

  assert.deepEqual(first.operations, [{
    type: "update_working_memory",
    summary: "Compare rollout plans",
    candidate_options: ["Canary"],
  }]);

  first.operations[0].summary = "Mutated returned output";
  first.operations[0].candidate_options.push("Big bang");

  providerOutput.operations[0] = {
    type: "update_working_memory",
    summary: "Fresh provider output",
    candidate_options: ["Canary"],
  };

  const second = normalizeUpdate(providerOutput);
  assert.deepEqual(second.operations, [{
    type: "update_working_memory",
    summary: "Fresh provider output",
    candidate_options: ["Canary"],
  }]);
});

test("normalizeUpdate accepts strict-schema working memory board_focus clearing operation", () => {
  assert.deepEqual(normalizeUpdate({
    action: "update",
    operations: [{
      type: "update_working_memory",
      board_focus: null,
    }],
  }), {
    action: "update",
    operations: [{
      type: "update_working_memory",
      board_focus: null,
    }],
    spoken_commit_notice: "",
    needs_clarification: "",
  });
});

test("natural reasoning undo utterances are detected without catching unrelated undo talk", async () => {
  const positiveUtterances = [
    "please undo the last reasoning update",
    "can you undo the previous decision",
    "undo that last memory update",
    "undo the last conclusion",
  ];
  const negativeUtterances = [
    "I do not want to undo the last decision",
    "explain undo memory semantics",
    "undo the last board layout",
  ];

  for (const utterance of positiveUtterances) {
    let providerCalled = false;
    const result = await proposeWorkspaceUpdate({ utterance }, createWorkspace(), {
      updateProvider: async () => {
        providerCalled = true;
        return { action: "update" };
      },
    });

    assert.equal(providerCalled, false, utterance);
    assert.equal(result.action, "undo", utterance);
    assert.deepEqual(result.operations, [], utterance);
  }

  for (const utterance of negativeUtterances) {
    let providerCalled = false;
    const result = await proposeWorkspaceUpdate({ utterance }, createWorkspace(), {
      updateProvider: async () => {
        providerCalled = true;
        return { action: "clarify", operations: [] };
      },
    });

    assert.equal(providerCalled, true, utterance);
    assert.notEqual(result.action, "undo", utterance);
  }
});

test("API call path uses fetchImpl, selected/default model, bearer auth, JSON schema request, and parses output_text", async () => {
  const previousModel = process.env.ORCHESTRATOR_MODEL;
  process.env.ORCHESTRATOR_MODEL = "test-workspace-update-model";
  let requestUrl;
  let requestOptions;

  try {
    const result = await proposeWorkspaceUpdate({
      turn_id: "turn-api",
      utterance: "Commit that canary is the preferred option.",
      spoken_context: "We compared rollout choices.",
    }, createWorkspace(), {
      apiKey: "test-key",
      fetchImpl: async (url, options) => {
        requestUrl = url;
        requestOptions = options;
        return {
          ok: true,
          async json() {
            return {
              output_text: JSON.stringify({
                action: "update",
                operations: [
                  {
                    type: "add_entry",
                    id: "decision-1",
                    category: "decisions",
                    content: "Canary is preferred",
                    origin: "user_stated",
                    source_turn_id: "turn-api",
                  },
                ],
                spoken_commit_notice: "I saved canary as the preferred option.",
                needs_clarification: "",
              }),
            };
          },
        };
      },
    });

    const body = JSON.parse(requestOptions.body);
    assert.equal(requestUrl, "https://api.openai.com/v1/responses");
    assert.equal(requestOptions.method, "POST");
    assert.equal(requestOptions.headers.Authorization, "Bearer test-key");
    assert.equal(requestOptions.headers["Content-Type"], "application/json");
    assert.equal(body.model, "test-workspace-update-model");
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.name, "workspace_update");
    assert.deepEqual(body.text.format.schema.required, [
      "action",
      "operations",
      "spoken_commit_notice",
      "needs_clarification",
    ]);
    assert.equal(JSON.parse(body.input[1].content).spoken_context, "We compared rollout choices.");
    assert.equal(result.action, "update");
    assert.equal(result.operations[0].origin, "user_stated");
    assert.equal(result.spoken_commit_notice, "I saved canary as the preferred option.");

    const operationItems = body.text.format.schema.properties.operations.items;
    const operationSchemas = operationItems.anyOf || [operationItems];
    assert.ok(operationSchemas.length > 1);
    operationSchemas.forEach((schema) => {
      assert.equal(schema.type, "object");
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
    });
  } finally {
    if (previousModel === undefined) {
      delete process.env.ORCHESTRATOR_MODEL;
    } else {
      process.env.ORCHESTRATOR_MODEL = previousModel;
    }
  }
});

test("non-ok API response throws useful error", async () => {
  await assert.rejects(
    () => proposeWorkspaceUpdate({
      utterance: "Save this update.",
    }, createWorkspace(), {
      apiKey: "test-key",
      fetchImpl: async () => ({
        ok: false,
        async json() {
          return { error: { message: "Bad schema request" } };
        },
      }),
    }),
    /Bad schema request/
  );
});
