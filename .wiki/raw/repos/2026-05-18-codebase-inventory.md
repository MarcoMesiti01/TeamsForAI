---
title: "TeamsForAI Codebase Inventory"
source: "local repository scan on 2026-05-18"
type: repos
ingested: 2026-05-18
tags: [repository, code-inventory, architecture, tests]
summary: "Inventory of the TeamsForAI repository structure, important modules, HTTP endpoints, frontend behavior, and test coverage as observed from the local source tree."
---

# TeamsForAI Codebase Inventory

This inventory summarizes the local repository at `C:\Users\Utente\Python_VSC\TeamsForAI` as of 2026-05-18. It is a navigation source for compiled wiki articles, not a replacement for reading the source files.

## Root Files

- `server.js`: Express application, static frontend hosting, Realtime session creation, tool execution bridge, board state endpoints, whiteboard job endpoints, board operation endpoints, and fallback SPA route.
- `README.md`: Product and setup documentation.
- `package.json`: Node package metadata. Scripts are `dev`, `start`, and `test`; runtime dependencies are `dotenv` and `express`.
- `.env.example`: Documents `OPENAI_API_KEY`, realtime/orchestrator/brain/whiteboard model variables, and `PORT`.
- `flights found.txt`: Output target for the legacy mock flight workflow.

## Backend Modules

- `lib/modelPolicy.js`: Defines model roles and maps each role to an environment variable plus fallback model.
- `lib/orchestratorService.js`: Builds compact orchestration input, calls the model-backed orchestrator when possible, normalizes decisions, and provides deterministic fallback routing.
- `lib/intentRouter.js`: Thin wrapper around `createOrchestratorDecision`.
- `lib/brainService.js`: Normalizes intent, calls the whiteboard planner for board-first work, applies validated board operations, handles the legacy flight workflow, and calls the brain model for non-board conversational work.
- `lib/boardState.js`: Owns board data shape, supported operation types, operation application, append-only operation log, checkpoint undo, and board snapshots.
- `lib/boardOperationValidator.js`: Filters invalid or unsafe board operation batches before they mutate board state.
- `lib/boardContext.js`: Builds compact board context for model prompts and tracks selected or recently moved items.
- `lib/whiteboardCommandService.js`: Normalizes direct whiteboard commands, resolves board targets, blocks risky destructive edits, and converts commands into operation batches.
- `lib/whiteboardPlannerService.js`: Builds planner input, calls a strict JSON whiteboard planner, validates output, and falls back to deterministic artifact layouts.
- `lib/whiteboardJobService.js`: Queues asynchronous whiteboard jobs, runs planning, applies operations, records status, and serializes jobs for polling.
- `lib/flightTools.js`: Legacy mock flight search and file save workflow.

## Frontend Modules

- `public/index.html`: Three-zone UI with transcript panel, full-board canvas, and control pane.
- `public/app.js`: Browser WebRTC setup, Realtime data-channel event handling, backend tool execution, board rendering, SVG edge drawing, group drawing, drag persistence, job polling, undo, connect/disconnect, and microphone toggling.
- `public/style.css`: Full-viewport whiteboard layout, command pane, transcript overlay, grid board background, card styling, groups, arrows, and mobile layout.

## Server Endpoints

- `POST /session`: Accepts WebRTC SDP, validates the offer, creates an OpenAI Realtime call, and returns SDP answer plus selected model and voice headers.
- `POST /tools/execute`: Executes Realtime tool calls: orchestration/brain delegation, direct whiteboard commands, and undo.
- `GET /board/state`: Returns the current board snapshot for a client session.
- `POST /board/commands`: Queues a whiteboard command as an async job.
- `GET /board/jobs`: Lists whiteboard jobs and current board state for polling.
- `POST /board/operations`: Applies user-originated board operations such as card moves.
- `POST /board/undo`: Restores the latest board checkpoint.
- `GET *`: Serves the frontend HTML.

## Test Coverage Map

The test runner loads unit-style tests for model policy, intent routing, board state, board context, operation validation, whiteboard command handling, planner behavior, job behavior, brain behavior, and frontend layout. Test names show coverage for fallback routing, multilingual detection, undo, destructive operation blocking, valid operation batches, job status transitions, strict planner output, deterministic planner fallback, and frontend job polling.
