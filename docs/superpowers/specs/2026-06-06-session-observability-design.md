# Session Observability Design

## Purpose

TeamsForAI needs enough runtime evidence to diagnose what happened during product use without repeatedly reconstructing bugs from memory. The observability system will record a full session timeline covering Realtime setup, tool calls, model interactions, whiteboard jobs, board state changes, frontend failures, and future endpoint/session activity.

The system will serve two audiences:

- Developers need complete local evidence after a session, including full prompts, responses, operations, errors, timings, and state.
- Users need a readable in-product timeline that explains what happened during the current session.

For this milestone, logs are intentionally full-fidelity. They may contain user speech text, model prompts, model responses, board content, and runtime state. The local log directory must be ignored by git.

## Current Context

The current app already has a board-level operation log in `lib/boardState.js`, but that log only records applied board operations. It does not explain the route that produced them, failed model/planner attempts, validation drops before mutation, frontend failures, or session setup issues.

The main runtime paths are:

- `server.js` creates Realtime sessions, manages session state, handles tool execution, queues whiteboard jobs, exposes board endpoints, and applies direct board operations.
- `lib/orchestratorService.js` routes user intent and chooses board strategies.
- `lib/brainService.js` handles deeper reasoning and board-first delegation.
- `lib/whiteboardPlannerService.js` turns intent into board operations through model-backed or fallback planning.
- `lib/whiteboardJobService.js` manages asynchronous whiteboard job lifecycle.
- `lib/boardState.js` mutates board state and records undoable operation history.
- `public/app.js` handles Realtime events, tool-call submission, polling, board rendering, drag persistence, and visible debug lines.

The existing board operation log is still useful and should remain. The new observability layer complements it by recording why each operation happened and what failed before or after it.

## Recommended Architecture

Add a central backend event recorder module, tentatively `lib/eventRecorder.js`.

The recorder will:

- Accept structured runtime events from backend services and routes.
- Keep recent events in memory grouped by `client_session_id` for UI reads.
- Append every event to local JSONL files under `runtime-logs/`.
- Generate event ids, timestamps, and trace ids when callers do not provide them.
- Tolerate logging failures without breaking product behavior.

Add two HTTP endpoints in `server.js`:

- `GET /logs/session?client_session_id=...` returns the current in-memory session timeline.
- `POST /logs/client-event` records frontend-only events such as browser failures, local UI actions, data-channel parse failures, polling failures, and connection failures.

Add a compact frontend "Session Log" panel in `public/index.html` and `public/app.js`.

The UI will:

- Fetch the current session timeline.
- Show a readable event list with time, category, status, and summary.
- Include simple category filters for model, board, job, tool, session, frontend, and error events.
- Keep raw JSON available per event for deeper inspection.

## Event Shape

Each event should be JSON-serializable and stable enough for later analysis.

Required fields:

- `event_id`: unique event id.
- `timestamp`: ISO timestamp.
- `session_id`: browser session id or `default`.
- `trace_id`: id linking related events in a single flow.
- `category`: broad event area.
- `action`: concrete event action.
- `status`: `started`, `completed`, `failed`, `warning`, or `info`.
- `summary`: short human-readable description.
- `payload`: full structured details.

Initial categories:

- `session`: Realtime setup, model/voice selection, session creation, SDP validation.
- `tool`: Realtime tool calls, backend route path, request arguments, response payloads.
- `model`: orchestrator, brain, and whiteboard planner requests/responses.
- `board`: direct operations, AI operations, validation results, undo, snapshots, checkpoints.
- `whiteboard_job`: queued, planning, applying, completed, failed, needs clarification.
- `frontend`: browser events and client-side failures.
- `error`: unexpected failures, including request and service errors.

## Trace Model

Every backend request that can trigger a multi-step flow should create or propagate a `trace_id`.

Examples:

- A Realtime tool call gets one trace id across `/tools/execute`, routing, model calls, job creation, planner output, board application, and frontend polling result.
- A direct drag operation gets one trace id across `/board/operations`, board mutation, and frontend success or failure.
- A Realtime session attempt gets one trace id across SDP validation, model/voice selection, upstream Realtime request, and success or failure.

Trace ids make it possible to read the timeline as a causality chain instead of disconnected events.

## Logged Runtime Flows

### Realtime Session Setup

`POST /session` will record:

- Start of session creation.
- Requested model and voice.
- Selected model and voice.
- SDP validation failures, including content type, length, and first SDP line.
- Upstream Realtime request outcome.
- Response status, errors, and duration.

### Tool Execution

`POST /tools/execute` will record:

- Tool name, call id if available, arguments, and session id.
- Selected-item and recently-moved-item context changes.
- Routed intent and chosen path.
- Whether the flow queued a whiteboard job, delegated to brain, executed undo, or failed.
- Full response payload sent back to the frontend.
- Duration and error details.

### Model Interactions

Model-facing services will record:

- Selected model, model role, complexity, latency budget, and artifact type.
- Full request input and prompts.
- Full raw model response.
- Parsed normalized output.
- Usage object when available.
- Fallback reason when a deterministic path is used.
- Duration and errors.

This applies to:

- `lib/orchestratorService.js`
- `lib/brainService.js`
- `lib/whiteboardPlannerService.js`

### Whiteboard Jobs

`lib/whiteboardJobService.js` will record each lifecycle transition:

- `queued`
- `planning`
- `needs_clarification`
- `applying`
- `completed`
- `failed`

Job logs will include command input, target resolution, planner summary, warnings, board operations, checkpoint id, final board state, and error details.

### Board State

Board logs will make it explicit what was drawn on the whiteboard.

Board events will include:

- Full operation batches.
- Operation source, such as `ai`, `user`, or `system`.
- Job id and trace id when available.
- Board version before and after mutation.
- Undo checkpoint id.
- Full resulting board state when available.
- Undo events and restored board state.

Because generated and applied `board_operations` are logged together with final `board_state`, a later analysis can reconstruct what appeared on the whiteboard, when it appeared, why it appeared, and which model/tool path produced it.

### Validation and Fallbacks

Validation and fallback events will record:

- Raw operations proposed by the planner.
- Valid operations that survived validation.
- Dropped operations and warning messages.
- Fallback planner usage and reason.
- Missing information or clarification requests.

This is important because many visible bugs come from invalid operations that never reach `applyBoardOperations`.

### Frontend Events

The frontend will send client-only events through `POST /logs/client-event`.

Initial frontend events:

- Realtime data channel opened or closed.
- Realtime data-channel JSON parse failure.
- Tool call submission started, completed, or failed.
- Board job polling failure.
- Board drag save success or failure.
- Realtime connection failure.
- UI timeline refresh failure.

The frontend should avoid blocking product behavior if logging fails.

## Local File Logging

Local event files will live under:

`runtime-logs/YYYY-MM-DD.jsonl`

Each line will be one complete JSON event.

The project `.gitignore` will include:

`runtime-logs/`

JSONL is chosen because it is simple to append, resilient if the process stops mid-session, and easy to inspect later with scripts or text search.

## UI Timeline

The Session Log panel will be readable first and technical second.

Each row will show:

- Timestamp.
- Category.
- Status.
- Summary.
- Trace id short form.

Each row can expand to show raw event JSON.

Filters will include:

- All
- Errors
- Model
- Board
- Jobs
- Tools
- Session
- Frontend

The UI timeline is not the durable source of truth. It reads recent in-memory events from the backend. The local JSONL files are the durable debugging artifact for later analysis.

## Error Handling

Logging must never break the app.

Rules:

- If file writing fails, keep recording in memory when possible.
- If memory recording fails, the product flow continues.
- If `POST /logs/client-event` fails, the frontend does not retry aggressively.
- Event payload serialization should guard against circular or non-serializable values.
- Large payloads are allowed for now, but recorder code should isolate serialization in one place so redaction or truncation can be added later.

## Privacy and Retention

For this milestone, full logging is intentional.

The system will log:

- User text and transcribed content.
- Full model prompts and inputs.
- Full model responses.
- Board state and operation history.
- Frontend and backend error details.

This is acceptable only because logs are local development artifacts and ignored by git. Future work should add redaction, retention limits, export controls, and user-facing warnings before production or shared usage.

## Tests

Add focused tests for:

- Event recorder appends valid JSONL events.
- Event recorder returns in-memory events by session id.
- Recorder tolerates serialization or file-write failures.
- `/logs/session` returns session events.
- `/logs/client-event` records frontend events.
- Board operations emit board events with operations and resulting board state.
- Whiteboard jobs emit lifecycle events.
- Model service tests can inject a recorder and assert model input/output events without requiring real network calls.

Existing tests for board state, planner, job service, and routing should remain focused. New tests should assert observability behavior without changing core product semantics.

## Acceptance Criteria

The milestone is accepted when:

- A live session produces local JSONL logs under `runtime-logs/`.
- `runtime-logs/` is ignored by git.
- The UI shows a readable current-session timeline.
- A tool-call flow can be traced from frontend tool call to backend route, routing/model decision, job/planner path, board operations, and rendered board state.
- A failed model call, failed planner output, failed board operation, or frontend polling failure is visible in both file logs and the session timeline.
- The app continues to work if logging fails.

## Out of Scope

This milestone does not include:

- Remote telemetry.
- User analytics.
- Persistent database storage.
- Production privacy controls.
- Automatic bug diagnosis.
- Log rotation beyond daily JSONL files.
- Historical log browsing inside the UI.
- Endpoint/session monitoring beyond the currently implemented local app routes.

## Future Work

Future improvements can add:

- Redaction and prompt/response truncation modes.
- Log export bundles.
- Session replay or board reconstruction tooling.
- Endpoint-level middleware for automatic request/response spans.
- Long-term session ids and durable session storage.
- Analysis scripts that summarize pain points, repeated errors, slow model calls, and invalid planner outputs.
