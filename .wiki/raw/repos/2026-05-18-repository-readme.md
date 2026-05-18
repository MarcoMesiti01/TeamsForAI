---
title: "TeamsForAI Repository README"
source: "README.md"
type: repos
ingested: 2026-05-18
tags: [repository, readme, teamsforai, whiteboard]
summary: "README snapshot describing TeamsForAI as a localhost voice-driven AI whiteboard protocol with an Express backend, plain frontend, OpenAI Realtime session setup, routing, brain reasoning, board operations, DOM/SVG board rendering, drag moves, and undo."
---

# TeamsForAI Repository README

The repository README describes TeamsForAI as a localhost web application that connects browser voice input and output to the OpenAI Realtime API, then turns spoken thinking into structured intent, deeper backend reasoning, and typed whiteboard operations.

## Product Shape

- Express backend with a secure `/session` endpoint that uses the server-side `OPENAI_API_KEY`.
- Plain HTML, CSS, and JavaScript frontend with connect, disconnect, mute, transcript, model override, and voice selection controls.
- A voice controller, router, and brain split where the realtime model handles low-latency voice UX and the backend handles routing plus deeper reasoning.
- A typed board protocol supporting `create_node`, `update_node`, `create_edge`, `create_group`, `move_item`, `emphasize_item`, `delete_item`, and `undo`.
- A DOM/SVG whiteboard that renders nodes as draggable cards, relationships as arrows, and groups as visual regions.

## Runtime Example

The README's example request is: "Map the core idea for a voice-first AI whiteboard for startup founders."

The expected flow is:

1. The realtime controller calls `route_user_intent`.
2. The router returns structured intent for an `idea_map`.
3. The brain creates typed board operations.
4. The server applies operations to session board state.
5. The UI renders the board and enables Undo.
6. The realtime controller speaks a concise summary.

## Operational Notes

The README states that board state and undo live in `lib/boardState.js`, routing lives in `lib/intentRouter.js`, and brain orchestration lives in `lib/brainService.js`. It also notes that an older mock flight workflow remains in backend code, while the active product path is the AI whiteboard protocol and DOM/SVG board.
