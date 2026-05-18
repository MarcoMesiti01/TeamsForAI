---
title: "Frontend Function Map"
category: reference
sources:
  - "raw/repos/2026-05-18-codebase-inventory.md"
  - "raw/repos/2026-05-18-repository-readme.md"
created: 2026-05-18
updated: 2026-05-18
tags: [frontend, functions, realtime, whiteboard, browser]
aliases: [Frontend Function Guide, Browser Logic Map]
confidence: high
volatility: warm
verified: 2026-05-18
summary: "Function-by-function guide for public/app.js, describing Realtime connection, transcript handling, board rendering, polling, drag persistence, and controls."
---

# Frontend Function Map

> `public/app.js` is the browser runtime. It owns WebRTC setup, Realtime event handling, tool-call forwarding, board rendering, job polling, drag persistence, and UI controls.

## Session And UI State

Top-level DOM constants cache controls, transcript, board, and status elements. `clientSessionId` is generated once with `crypto.randomUUID()` so every backend call belongs to one in-memory session. The mutable state variables hold the peer connection, data channel, audio element, microphone stream, transcript item map, handled tool-call ids, current board snapshot, active drag, pending/completed job ids, and the polling timer.

## Status And Transcript

`setStatus(text)` writes the user-facing connection or board update state.

`appendLine(role, text)` appends a transcript row, prefixes it with the role, scrolls to the bottom, and returns the created element. All system, user, assistant, and debug text flows through this helper.

`appendDebug(text)` writes a system line with a debug prefix. It keeps debug output visually separate without needing another rendering path.

`upsertTranscriptItem(itemId, role, text)` updates an existing transcript row when Realtime streams deltas for the same item id, or appends a new row when no prior item exists.

## Whiteboard Job Polling

`trackWhiteboardJob(job)` stores a pending job id, changes status to board updating, announces the quick acknowledgement, and starts polling.

`startBoardJobPolling()` starts a 900 ms interval if one is not already active, then immediately performs one poll. This avoids waiting almost a second before the first status check.

`stopBoardJobPollingIfIdle()` clears the polling interval when no pending jobs remain and restores the status to connected or idle.

`pollWhiteboardJobs()` calls `GET /board/jobs`, finds pending jobs, renders completed board state, reports completed summaries, reports failures or clarification requests, and always checks whether polling can stop.

## Board Geometry And Rendering

`getBoardSize(boardState)` computes the required canvas size from node positions, with minimum dimensions. The board grows as nodes are placed farther right or down.

`getNodeById(boardState, id)` returns a node by id.

`getNodeCenter(node)` converts a node's top-left coordinates into center coordinates for curved edge paths.

`clearElement(element)` removes all children from a DOM element. Rendering uses it to avoid stale nodes and SVG layers.

`createSvgElement(name, attrs)` creates an SVG element and applies attributes. Edge rendering uses it for paths, markers, and labels.

`drawEdges(edgeLayer, boardState)` clears the SVG edge layer, defines the arrow marker, resolves each edge's endpoint nodes, draws a curved path, and adds a text label when present. Missing endpoints are skipped instead of breaking rendering.

`getGroupBounds(boardState, group)` computes a group's visual region from its member nodes, adding padding for label and boundaries. Empty groups return `null`.

`drawGroups(groupLayer, boardState)` clears group regions and renders each group as a positioned section with a label, using `getGroupBounds`.

`refreshBoardGeometry()` recalculates board size, resizes SVG layers, and redraws groups and edges after node movement.

`renderBoard(boardState)` is the main board renderer. It stores the snapshot, updates status and undo state, clears the board, shows an empty state when there are no nodes, creates edge/group/node layers, renders every node card, binds drag handlers, and redraws groups and edges.

## Realtime Events And Tool Calls

`bindDataChannel(channel)` attaches Realtime data-channel handlers. On open/close it updates transcript status. On messages it parses JSON events, updates user transcription, streams assistant transcript deltas, handles final assistant transcript text, reports Realtime errors, and executes function calls exactly once using `handledToolCalls`.

`executeToolCall(name, rawArguments, callId)` parses function-call arguments, posts the call to `/tools/execute`, sends the function output back into Realtime, asks Realtime to continue with `response.create`, renders immediate board state, tracks async jobs, and appends debug metadata for backend delegation results.

## Undo And Drag Persistence

`undoBoard()` posts to `/board/undo`, renders the returned board state, and writes a system line explaining whether anything was undone.

`startNodeDrag(event)` captures the pointer when a node card is pressed, records starting pointer and node coordinates, and marks the card as dragging.

`moveDraggedNode(event)` updates the local node coordinates while dragging, clamps the minimum visible position, moves the DOM card, and refreshes group and edge geometry. This is optimistic local movement only.

`finishNodeDrag(event)` ends dragging, ignores unchanged moves, posts a `move_item` operation to `/board/operations`, renders the saved board on success, and rolls the node back to its original coordinates if persistence fails.

## Connection Controls

`connect()` creates the WebRTC connection. It reads optional model and voice inputs, opens an `RTCPeerConnection`, attaches remote audio playback, asks for microphone access, creates the Realtime data channel, builds an SDP offer, posts it to `/session`, applies the SDP answer, enables controls, and reports the selected model and voice. On failure it reports the error and cleans up.

`cleanup()` closes the data channel and peer connection, stops microphone tracks, detaches audio, disables controls, and returns status to idle.

`disconnect()` writes a system transcript line and calls `cleanup()`.

`toggleMic()` toggles microphone track `enabled` flags, updates the button label, and writes a system line.

The final event-listener block wires connect, disconnect, microphone, undo, pointer movement, pointer release/cancel, and the initial empty-board render.

## See Also

- [[backend-function-map|Backend Function Map]] ([Backend Function Map](backend-function-map.md)) - backend functions receiving these calls.
- [[runtime-request-flow|Runtime Request Flow]] ([Runtime Request Flow](../topics/runtime-request-flow.md)) - how browser actions travel through Realtime and backend routing.
- [[operation-lifecycle|Operation Lifecycle]] ([Operation Lifecycle](../concepts/operation-lifecycle.md)) - how rendered operations become persistent board state.
