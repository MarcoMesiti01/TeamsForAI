---
title: "Code Navigation Guide"
category: reference
sources:
  - "raw/repos/2026-05-18-codebase-inventory.md"
  - "raw/repos/2026-05-18-repository-readme.md"
created: 2026-05-18
updated: 2026-05-18
tags: [code-navigation, reference, tests, files]
aliases: [File Map, Repository Guide]
confidence: high
volatility: warm
verified: 2026-05-18
summary: "Practical file-by-file guide for navigating TeamsForAI by product concern, backend service, frontend behavior, and test coverage."
---

# Code Navigation Guide

> Use this guide to jump from a product question to the files most likely to contain the answer.

## Product Entry Points

| Question | Start Here | Why |
|---|---|---|
| How does the app start? | `server.js` | Express setup, middleware, static frontend, and route definitions live here. |
| How does a browser connect to voice? | `public/app.js`, `POST /session` in `server.js` | The frontend creates WebRTC state and the backend performs the SDP exchange. |
| What does the user see? | `public/index.html`, `public/style.css`, `public/app.js` | These define the transcript, board, controls, rendering, and interactions. |
| What is the intended product? | `README.md` | The README documents the voice-driven whiteboard protocol and expected flow. |

## Backend Logic Map

| Concern | File |
|---|---|
| Model role defaults and environment model selection | `lib/modelPolicy.js` |
| Intent input building, model-backed routing, fallback decisions | `lib/orchestratorService.js` |
| Router facade | `lib/intentRouter.js` |
| Brain delegation, board-first handling, legacy flight path | `lib/brainService.js` |
| Board state mutation and undo checkpoints | `lib/boardState.js` |
| Board operation safety checks | `lib/boardOperationValidator.js` |
| Compact prompt context for board state | `lib/boardContext.js` |
| Direct whiteboard command normalization and target resolution | `lib/whiteboardCommandService.js` |
| Planner model input, strict planner output, deterministic layout fallback | `lib/whiteboardPlannerService.js` |
| Async whiteboard job lifecycle | `lib/whiteboardJobService.js` |
| Mock flight search and file output | `lib/flightTools.js` |

## Frontend Behavior Map

| Concern | File / Function Area |
|---|---|
| Connect, SDP offer, media stream, data channel | `public/app.js` connection functions |
| Realtime event parsing and transcript updates | `public/app.js` data-channel handler |
| Tool call execution bridge | `public/app.js` `executeToolCall` |
| Board node, group, and edge rendering | `public/app.js` board rendering functions |
| Drag persistence | `public/app.js` pointer handlers and `/board/operations` call |
| Job polling | `public/app.js` job tracking and polling functions |
| Visual layout | `public/style.css` |

## Test Map

| Behavior | Tests |
|---|---|
| Model role selection and fallback | `test/modelPolicy.test.js` |
| Orchestrator routing, fallback artifact selection, undo, multilingual requests | `test/intentRouter.test.js` |
| Board operation application, append-only log, undo, move checkpoints | `test/boardState.test.js` |
| Compact board context | `test/boardContext.test.js` |
| Operation validation and destructive operation blocking | `test/boardOperationValidator.test.js` |
| Command normalization, target resolution, direct operation planning | `test/whiteboardCommandService.test.js` |
| Planner input, strict planner JSON, fallback layouts | `test/whiteboardPlannerService.test.js` |
| Async job creation, completion, failure behavior | `test/whiteboardJobService.test.js` |
| Brain service board-first path and language handling | `test/brainService.test.js` |
| Frontend command pane and job polling hooks | `test/frontendLayout.test.js` |

## Suggested Reading Order

1. Read [[project-overview|Project Overview]] ([Project Overview](../topics/project-overview.md)).
2. Read [[runtime-request-flow|Runtime Request Flow]] ([Runtime Request Flow](../topics/runtime-request-flow.md)).
3. Read [[board-operation-protocol|Board Operation Protocol]] ([Board Operation Protocol](../concepts/board-operation-protocol.md)).
4. Read [[operation-lifecycle|Operation Lifecycle]] ([Operation Lifecycle](../concepts/operation-lifecycle.md)) for operation-by-operation board mutation details.
5. Use [[backend-function-map|Backend Function Map]] ([Backend Function Map](backend-function-map.md)) and [[frontend-function-map|Frontend Function Map]] ([Frontend Function Map](frontend-function-map.md)) when you need function-level implementation logic.

## See Also

- [[project-overview|Project Overview]] ([Project Overview](../topics/project-overview.md)) - why these files exist.
- [[runtime-request-flow|Runtime Request Flow]] ([Runtime Request Flow](../topics/runtime-request-flow.md)) - how the files work together at runtime.
- [[whiteboard-planning-and-jobs|Whiteboard Planning And Jobs]] ([Whiteboard Planning And Jobs](../concepts/whiteboard-planning-and-jobs.md)) - async board update internals.
- [[operation-lifecycle|Operation Lifecycle]] ([Operation Lifecycle](../concepts/operation-lifecycle.md)) - operation-by-operation mutation details.
- [[backend-function-map|Backend Function Map]] ([Backend Function Map](backend-function-map.md)) - backend function logic and process.
- [[frontend-function-map|Frontend Function Map]] ([Frontend Function Map](frontend-function-map.md)) - browser function logic and process.

## Sources

- [TeamsForAI Codebase Inventory](../../raw/repos/2026-05-18-codebase-inventory.md) - file inventory, endpoint list, module roles, and test coverage map.
- [TeamsForAI Repository README](../../raw/repos/2026-05-18-repository-readme.md) - product overview and expected behavior.
