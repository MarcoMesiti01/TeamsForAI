---
title: "Backend Function Map"
category: reference
sources:
  - "raw/repos/2026-05-18-codebase-inventory.md"
  - "raw/repos/2026-05-18-repository-readme.md"
created: 2026-05-18
updated: 2026-05-18
tags: [backend, functions, server, orchestration, whiteboard]
aliases: [Backend Function Guide, Server Logic Map]
confidence: high
volatility: warm
verified: 2026-05-18
summary: "Function-by-function navigation for server.js and backend service modules, explaining each function's role and the process behind it."
---

# Backend Function Map

> Read this as the backend call graph. Each function is described by what it accepts, what decision it makes, and what state or output it produces.

## `server.js`

`getSessionState(clientSessionId)` is the in-memory session initializer. It returns an existing session when the browser already has one; otherwise it creates a new state object with task memory, a fresh board, selection context, and recent movement context. This is the anchor that lets all board operations remain scoped to the browser session id.

`POST /session` creates the Realtime connection. The route validates the SDP body, rejects missing or malformed offers, selects the voice and realtime model, builds the Realtime tool definitions and controller instructions, forwards the offer to OpenAI, then returns the SDP answer plus model and voice headers. The logic keeps layout and planning away from the realtime model; the realtime model only gets tools for delegation, direct board command submission, and undo.

`POST /tools/execute` is the backend bridge for Realtime function calls. It parses the tool name, loads the session state, and then branches by tool:

- `delegate_to_orchestrator`, `route_user_intent`, and `delegate_to_brain`: update selected-item context, route intent unless the tool already supplied brain input, queue a whiteboard job when routing says `should_use_whiteboard`, or delegate to the brain service for conversational or board-first work.
- `submit_whiteboard_command`: normalizes a direct board edit request into a queued whiteboard job.
- `undo_board_operation`: restores the previous board checkpoint immediately.
- Unknown names return a 400 response so the browser can surface a failed tool call.

`GET /board/state` returns the current session board snapshot. It is read-only and exists so the browser or tests can inspect the latest state without triggering planning.

`POST /board/commands` queues a whiteboard command outside the Realtime tool bridge. It accepts either `body.command` or the body itself as the command payload, creates a job, stores it in session state, and returns 202 with the job id and current board snapshot.

`GET /board/jobs` returns serialized jobs plus the board snapshot. The frontend polls this endpoint while async planning is in progress.

`POST /board/operations` applies explicit operation batches from the frontend, mainly drag persistence. It rejects empty operation arrays, stores selected item context, applies the operations through `boardState`, and records `recently_moved_item` when the batch contains `move_item`.

`POST /board/undo` restores the latest undo checkpoint for the session board. It is the HTTP equivalent of the Realtime `undo_board_operation` tool.

`GET *` serves `public/index.html` for any unmatched path, keeping the app usable as a simple single-page demo.

`app.listen(...)` starts the localhost service and prints the chosen port.

## `lib/modelPolicy.js`

`normalizeText(value)` turns nullable input into a trimmed string. The rest of the policy layer uses it to avoid leaking `undefined`, whitespace, or non-string values into model selection.

`normalizeComplexity(complexity)` accepts only `low`, `medium`, or `high`; anything else becomes `medium`. This prevents arbitrary caller input from becoming a policy dimension.

`normalizeLatencyBudget(latencyBudget)` accepts `realtime`, `low`, `medium`, or `relaxed`; anything else becomes `medium`. Realtime setup and backend model calls use this to express latency needs without changing the selection mechanism.

`getRoleDefault(role)` maps a model role to its environment variable and fallback model. It throws when the role is unknown because model role mistakes should fail early.

`selectModel({ role, complexity, latency_budget, artifact_type })` is the public selector. It normalizes inputs, resolves the configured model from the role's environment variable or fallback, and returns a structured selection record with role, model, policy inputs, and source env var.

## `lib/intentRouter.js`

`routeUserIntent(payload, options)` is a facade over `createOrchestratorDecision`. The file exists so callers depend on an intent-router boundary instead of importing the full orchestrator implementation directly.

## `lib/orchestratorService.js`

`normalizeText(value)` standardizes string fields used by routing.

`getApiKey()` reads `OPENAI_API_KEY` from the process environment.

`compactConversationContext(payload, limit)` builds a compact context string from named fields first, then falls back to the last conversation messages. The route model receives enough context to classify the turn without the full transcript.

`compactBoardSnapshot(board)` strips the board down to recent node, edge, group, and undo metadata. It preserves ids and labels but removes heavy operation history.

`getDefaultCapabilities()` lists artifact types, board operations, and backend tools available to the orchestrator. This becomes part of the routing prompt so the model chooses only supported paths.

`buildOrchestratorInput(payload, options)` validates `user_goal`, builds compact conversation and board context, attaches capability metadata, and carries through response mode and visible board hints. This is the canonical input shape for both model routing and deterministic fallback.

`fallbackDecision(input, reason)` makes deterministic routing decisions when the model is unavailable or unnecessary. It recognizes undo, detects artifact-like thinking work, chooses a board strategy, and otherwise returns a low-confidence conversational route.

`inferArtifactType(goal)` classifies a user goal into `conversation`, `idea_map`, `process_flow`, `architecture_map`, `comparison_map`, or `action_plan` using multilingual keyword patterns and explicit no-board exclusions.

`inferBoardStrategy(lowerGoal, visibleContext, boardHasContent)` chooses whether to create a new group, refine existing content, or reorganize the current board. It prefers `create_new_group` on an empty board and `refine_existing` for follow-up language.

`coerceArray(value)` converts model output arrays into clean string arrays.

`normalizeToolPlan(value)` keeps only tool-plan steps with a tool name, normalizes args, and preserves the reason string.

`inferRouteAction(decision)` derives a route action when the model omitted or mismatched it. Intent type and `should_use_whiteboard` are the fallback signals.

`normalizeDecision(rawDecision, input)` validates model output, clamps confidence, normalizes board strategy and tool plan, adds user goal and context, and builds a board command when the decision uses the whiteboard.

`parseModelJson(data)` extracts JSON text from Responses API output shapes and parses it.

`callOrchestratorModel(input, options)` selects the orchestrator model, sends the strict JSON-schema request, and normalizes the returned decision. Missing API key returns deterministic fallback; API errors throw to the caller.

`createOrchestratorDecision(payload, options)` builds input, allows test/provider injection, returns deterministic undo immediately, then tries the model and falls back on errors.

## `lib/brainService.js`

`isFlightTask(taskType, userGoal)` detects the legacy mock flight workflow. It checks both normalized task type and user goal for flight-related terms.

`callBrainModel(input)` selects the brain model, verifies API-key availability, sends a strict JSON-schema response request, and returns a normalized brain result. If the model returns non-JSON text, the raw text is preserved as `full_response`.

`delegateToBrain(payload, sessionState)` is the high-level brain entry point. It builds board context, routes raw payloads when needed, updates session task memory, handles board-first intents through the whiteboard planner, handles legacy flight search, and otherwise calls the brain model with compact session state.

## `lib/boardContext.js`

`safeArray(value)` returns an array or `[]`; compactors use it to tolerate incomplete board snapshots.

`compactOperation(operation)` keeps only operation metadata useful for context: type, ids, label, checkpoint, source, and version.

`inferRecentlyMovedItem(snapshot)` scans the operation log backward for the latest `move_item`, returning a compact node reference. This helps later commands such as "move it again" or "connect the thing I just moved."

`buildCompactBoardContext(board, options)` creates the board context passed to orchestrator and planner. It includes recent nodes, groups, edges, recent operations, selected item, and recent moved item while keeping the payload small.

## `lib/boardState.js`

`createBoardState()` returns the mutable board container with version, nodes, edges, groups, operation log, and undo stack.

`clone(value)` deep-copies JSON-compatible board data.

`snapshotBoard(board)` captures version, nodes, edges, and groups before mutation. The undo stack stores this snapshot, not the operation diff.

`restoreSnapshot(board, snapshot)` replaces current visible board fields from a snapshot.

`makeId(prefix)` creates time/random ids for generated operations and checkpoints.

`requireOperationType(operation)` throws unless the operation type is supported.

`upsertById(items, item)` updates an existing item by id or appends it. Create operations are idempotent at the mutation layer, while the validator is responsible for rejecting duplicate creates when safety matters.

`applyOperation(board, operation)` performs the actual mutation for `create_node`, `update_node`, `create_edge`, `create_group`, `move_item`, `emphasize_item`, and `delete_item`.

`applyBoardOperations(board, operations, metadata)` validates operation types, snapshots the board, applies each operation, increments version per operation, appends log entries, pushes an undo checkpoint, and returns a fresh snapshot.

`undoLastCheckpoint(board)` pops the last checkpoint, restores its snapshot, increments version, appends an `undo` log entry, and returns the restored snapshot.

`getBoardSnapshot(board)` returns a cloned visible board plus operation log and `can_undo`.

`getSupportedOperationTypes()` exposes the operation type list to planner prompts and tests.

## `lib/boardOperationValidator.js`

`isStringId(value)` checks for non-empty string ids.

`collectExistingIds(board)` gathers node, edge, and group ids already present on the board.

`collectExistingNodeIds(board)` gathers current node ids for edge and group reference checks.

`collectBatchNodeIds(operations)` gathers node ids that will be created in the same batch, allowing a group to reference nodes created earlier or later in that batch.

`coordinatesAreFinite(operation)` enforces finite coordinates on `create_node` and `move_item`.

`validateBoardOperations(operations, board, options)` filters a batch into `validOperations` plus warnings. It rejects non-arrays, malformed operations, unsupported types, destructive operations without permission, missing ids, duplicate creates, invalid coordinates, missing edge endpoints, and invalid group membership.

## `lib/whiteboardCommandService.js`

`normalizeText(value)` and `normalizeConfidence(value, fallback)` standardize text and target confidence.

`normalizeWhiteboardCommand(input)` validates command type and returns a complete command object with artifact type, user goal, selector, confidence, constraints, destructive permission, board strategy, and visual summary.

`commandTypeFromGoal(goal, fallback)` infers a command type from English and Italian action words.

`buildWhiteboardCommandFromIntent(intent)` converts an orchestrator decision into a normalized whiteboard command, including selected/current item hints.

`textIncludes(haystack, needle)` performs normalized substring matching.

`collectItems(board)` returns normalized node, edge, and group arrays.

`findNodeByText(board, text)`, `findGroupByTitle(board, title)`, and `findItemById(board, id)` are target lookup helpers.

`resolveSingleTarget(selector, board, context)` resolves explicit selector forms in priority order: id, selected item, recent item, node text, title, then group title.

`resolveSemanticTarget(command, board)` uses words from the goal and change description to find a likely node when the selector is incomplete.

`resolveCommandTargets(command, board, context)` normalizes the command, resolves primary targets, resolves `from` and `to` endpoints for connection commands, and returns confidence.

`makeId(prefix, text)` creates readable ids from text plus a timestamp.

`planOperationsForCommand(commandInput, board, options)` is the command-to-operation compiler. It blocks unsafe destructive edits, delegates artifact creation/reorganization/replacement to the planner, resolves direct edit targets, builds raw operations for modify/move/connect/group/emphasize/delete, validates them, and returns status, summaries, warnings, target resolution, and board snapshot.

## `lib/whiteboardPlannerService.js`

`slugId(prefix, text, index)` creates deterministic-ish ids from artifact text and index.

`detectLanguage(text)` chooses `en`, `it`, `vi`, or `ja` from text patterns.

`getIdeaMapCopy(language)` returns localized fallback labels and summaries.

`extractIdeaMapTopics(intent)` starts from localized default topics and swaps terms when the goal mentions whiteboards, founders, design, diagrams, or maps.

`buildIdeaMapOperations(intent, board)` creates a grouped idea-map fallback with nodes and three labeled edges.

`buildLinearArtifactOperations(intent, board, config)` creates a left-to-right grouped sequence from config nodes and edge labels.

`buildClusterArtifactOperations(intent, board, config)` creates a grouped grid/cluster artifact from config nodes and indexed edge specs.

`buildProcessFlowOperations`, `buildArchitectureMapOperations`, `buildComparisonMapOperations`, and `buildActionPlanOperations` choose the proper fallback artifact config.

`buildFallbackOperations(intent, board, planInput)` dispatches artifact type to the matching deterministic operation builder.

`normalizeLayoutConstraints(value)` merges caller constraints with canvas, node, spacing, group, and edge readability defaults.

`buildWhiteboardPlanInput(intent, board, options)` builds the planner payload with artifact type, board strategy, goal, compact session context, board snapshot, board context, supported operations, layout constraints, and destructive-operation permission.

`parseModelJson(data)` extracts and parses Responses API JSON output.

`normalizePlannerOutput(rawOutput)` validates the planner response shape and normalizes summary, reasoning, operations, layout notes, and missing info.

`callWhiteboardPlannerModel(planInput, options)` supports injected planner providers, otherwise selects the planner model, sends strict JSON-schema instructions, and returns normalized planner output.

`buildFallbackPlan(intent, board, planInput, modelSelection, options, fallbackReason, sourceWarnings)` builds deterministic operations, validates them, and returns a planner-shaped response marked `used_fallback`.

`planWhiteboardOperations(intent, board, options)` is the public planner. It builds input, selects the model, calls the model for visual artifacts, falls back when the model fails or returns invalid operations, and returns an empty plan when the intent does not require a visual artifact.

## `lib/whiteboardJobService.js`

`ensureJobStore(sessionState)` creates `sessionState.whiteboard_jobs` when absent.

`makeJobId()` creates a unique job id.

`serializeJob(job)` returns the browser-safe job shape.

`createWhiteboardJob(sessionState, commandInput, options)` normalizes the command, creates a queued job, stores it, and schedules `runWhiteboardJob` asynchronously unless `autoStart` is disabled.

`getWhiteboardJob(sessionState, jobId)` finds a stored job by id.

`runWhiteboardJob(sessionState, jobId, options)` advances a job through planning and applying. It records target resolution and warnings, handles clarification and empty-operation failures, applies valid operations to board state, stores the undo checkpoint, and captures errors as failed jobs.

`listWhiteboardJobs(sessionState)` serializes every stored job for polling.

## `lib/flightTools.js`

`normalizeLocation(value)` converts city names or airport codes into airport-code arrays.

`formatFlightLine(f, idx)` renders one flight row for summaries and saved files.

`searchFlights(args)` validates route/date input, filters the mock dataset, sorts by price, limits results, and returns a structured search response.

`saveFlightsToFile(args)` writes the cheapest-flight output to `flights found.txt` and returns the saved path and count.

## See Also

- [[code-navigation-guide|Code Navigation Guide]] ([Code Navigation Guide](code-navigation-guide.md)) - file-level navigation.
- [[runtime-request-flow|Runtime Request Flow]] ([Runtime Request Flow](../topics/runtime-request-flow.md)) - end-to-end voice request flow.
- [[operation-lifecycle|Operation Lifecycle]] ([Operation Lifecycle](../concepts/operation-lifecycle.md)) - operation-by-operation mutation details.
