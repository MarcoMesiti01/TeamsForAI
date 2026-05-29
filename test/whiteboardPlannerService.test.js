const test = require("node:test");
const assert = require("node:assert/strict");

const { createBoardState, applyBoardOperations } = require("../lib/boardState");
const { buildWhiteboardPlanInput, planWhiteboardOperations } = require("../lib/whiteboardPlannerService");

test("builds planner input with board snapshot, supported operations, layout constraints, and session context", () => {
  const board = createBoardState();
  const workspaceContext = {
    active_entries: {
      options: [{ id: "option-canary", content: "Use canary rollout", status: "committed" }],
    },
  };
  applyBoardOperations(board, [
    { type: "create_node", id: "node-existing", text: "Existing idea", x: 120, y: 80 },
  ]);

  const input = buildWhiteboardPlanInput({
    intent_type: "develop_idea_map",
    user_goal: "Expand the existing idea",
    target_artifact: "idea_map",
    artifact_description: "Add a compact expansion around the existing idea.",
    known_context: "The user moved the first node to the top-left.",
    workspace_context: workspaceContext,
  }, board, {
    layout_constraints: { canvas_width: 1400, canvas_height: 900, min_node_spacing: 180 },
  });

  assert.equal(input.user_goal, "Expand the existing idea");
  assert.equal(input.artifact_description, "Add a compact expansion around the existing idea.");
  assert.equal(input.current_board_snapshot.nodes[0].text, "Existing idea");
  assert.equal(input.board_context.nodes[0].title, "Existing idea");
  assert.ok(input.supported_operation_types.includes("create_node"));
  assert.ok(input.supported_operation_types.includes("delete_item"));
  assert.equal(input.layout_constraints.canvas_width, 1400);
  assert.match(input.compact_session_context, /top-left/);
  assert.deepEqual(input.workspace_context, workspaceContext);
});

test("planner input isolates workspace metadata from caller mutations", () => {
  const board = createBoardState();
  const workspaceContext = {
    active_entries: {
      objectives: [{ id: "objective-growth", content: "Reduce churn", status: "committed" }],
    },
  };
  const input = buildWhiteboardPlanInput({
    user_goal: "Project workspace",
    target_artifact: "idea_map",
    workspace_context: workspaceContext,
  }, board);

  workspaceContext.active_entries.objectives[0].content = "Mutated original";
  input.workspace_context.active_entries.objectives[0].status = "mutated-input";

  assert.deepEqual(input.workspace_context, {
    active_entries: {
      objectives: [{ id: "objective-growth", content: "Reduce churn", status: "mutated-input" }],
    },
  });
  assert.deepEqual(workspaceContext, {
    active_entries: {
      objectives: [{ id: "objective-growth", content: "Mutated original", status: "committed" }],
    },
  });
});

test("planner input includes board strategy and visual summary goal", () => {
  const board = createBoardState();
  const input = buildWhiteboardPlanInput({
    intent_type: "develop_idea_map",
    user_goal: "Describe the onboarding process",
    target_artifact: "process_flow",
    artifact_type: "process_flow",
    board_strategy: "create_new_group",
    visual_summary_goal: "Show onboarding as ordered steps.",
  }, board);

  assert.equal(input.artifact_type, "process_flow");
  assert.equal(input.board_strategy, "create_new_group");
  assert.equal(input.visual_summary_goal, "Show onboarding as ordered steps.");
});

test("planner model request includes workspace projection guidance", async () => {
  const board = createBoardState();
  let requestBody = null;

  await planWhiteboardOperations({
    intent_type: "develop_idea_map",
    user_goal: "Project committed workspace entries",
    target_artifact: "idea_map",
    should_use_whiteboard: true,
    workspace_context: {
      active_entries: {
        options: [{ id: "option-canary", content: "Use canary rollout", status: "committed" }],
      },
    },
  }, board, {
    apiKey: "test-key",
    fetchImpl: async (_url, request) => {
      requestBody = JSON.parse(request.body);
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            spoken_summary: "Projected workspace",
            reasoning_summary: "Used active committed entries.",
            layout_notes: "Updated existing related nodes where possible.",
            missing_info: [],
            board_operations: [
              {
                type: "create_node",
                id: "node-option",
                text: "Use canary rollout",
                x: 120,
                y: 90,
                workspace_entry_id: "option-canary",
                memory_status: "committed",
                origin: "workspace",
              },
            ],
          }),
        }),
      };
    },
  });

  const systemPrompt = requestBody.input.find((message) => message.role === "system").content;
  const userInput = JSON.parse(requestBody.input.find((message) => message.role === "user").content);
  assert.match(systemPrompt, /active committed workspace entries are authoritative/i);
  assert.match(systemPrompt, /reuse\/update related nodes/i);
  assert.match(systemPrompt, /workspace_entry_id, memory_status, origin/i);
  assert.equal(userInput.workspace_context.active_entries.options[0].id, "option-canary");
});

test("planner uses strict JSON planner output when operations validate", async () => {
  const board = createBoardState();
  const plan = await planWhiteboardOperations({
    intent_type: "develop_idea_map",
    user_goal: "Create a process map",
    target_artifact: "idea_map",
  }, board, {
    plannerProvider: async () => ({
      spoken_summary: "I added a process map.",
      reasoning_summary: "The existing board is empty, so I created a compact starter map.",
      layout_notes: "Nodes are spaced horizontally with a readable edge.",
      missing_info: [],
      board_operations: [
        { type: "create_node", id: "node-1", text: "Start", x: 120, y: 90 },
        { type: "create_node", id: "node-2", text: "Finish", x: 360, y: 90 },
        { type: "create_edge", id: "edge-1", from: "node-1", to: "node-2", label: "then" },
      ],
    }),
  });

  assert.equal(plan.used_fallback, false);
  assert.equal(plan.spoken_summary, "I added a process map.");
  assert.equal(plan.layout_notes, "Nodes are spaced horizontally with a readable edge.");
  assert.deepEqual(plan.board_operations.map((operation) => operation.type), ["create_node", "create_node", "create_edge"]);
  assert.deepEqual(plan.validation_warnings, []);
});

test("planner falls back to fixture when planner output has invalid operations", async () => {
  const board = createBoardState();
  const plan = await planWhiteboardOperations({
    intent_type: "develop_idea_map",
    user_goal: "Create a process map",
    target_artifact: "idea_map",
  }, board, {
    plannerProvider: async () => ({
      spoken_summary: "Bad planner response",
      reasoning_summary: "This should be replaced.",
      layout_notes: "Invalid edge.",
      missing_info: [],
      board_operations: [
        { type: "create_edge", id: "edge-1", from: "node-1", to: "missing-node", label: "bad" },
      ],
    }),
  });

  assert.equal(plan.used_fallback, true);
  assert.equal(plan.board_operations.length, 9);
  assert.equal(plan.validation_warnings.length, 1);
  assert.match(plan.validation_warnings[0], /missing node references/);
});

test("fallback planner creates valid operation batches for core artifact types", async () => {
  const artifacts = [
    ["idea_map", "Map the core idea for a whiteboard"],
    ["process_flow", "Describe the customer onboarding process"],
    ["architecture_map", "Design the architecture for the voice AI whiteboard"],
    ["comparison_map", "Compare enterprise pilots and self serve launch paths"],
    ["action_plan", "Make an action plan for the next two weeks"],
  ];

  for (const [artifactType, userGoal] of artifacts) {
    const board = createBoardState();
    const plan = await planWhiteboardOperations({
      intent_type: "develop_idea_map",
      user_goal: userGoal,
      artifact_type: artifactType,
      target_artifact: artifactType,
      should_use_whiteboard: true,
      board_strategy: "create_new_group",
      visual_summary_goal: `Create a ${artifactType}`,
    }, board, { apiKey: "" });

    assert.equal(plan.used_fallback, true, `${artifactType} should use fallback without an API key`);
    assert.equal(plan.artifact_type, artifactType);
    assert.equal(plan.validation_warnings.length, 0, `${artifactType} should validate cleanly`);
    assert.ok(plan.board_operations.some((operation) => operation.type === "create_node"), `${artifactType} should create nodes`);
    assert.ok(plan.board_operations.some((operation) => operation.type === "create_group"), `${artifactType} should create a group`);
  }
});
