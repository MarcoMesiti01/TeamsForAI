---
title: "Runtime Request Flow"
category: topic
sources:
  - "raw/repos/2026-05-18-repository-readme.md"
  - "raw/repos/2026-05-18-codebase-inventory.md"
created: 2026-05-18
updated: 2026-05-18
tags: [runtime-flow, realtime, backend, frontend, whiteboard]
aliases: [Voice To Board Flow, Request Flow]
confidence: high
volatility: warm
verified: 2026-05-18
summary: "Explains how a spoken user request moves through the browser, Realtime session, backend tool execution, routing, planning, board state, and rendering."
---

# Runtime Request Flow

> A spoken request enters through the browser Realtime connection, becomes a backend tool call, is routed into either conversation or board work, and may produce board operations that update session board state and re-render the whiteboard.

## 1. Browser Connects To Realtime

The frontend creates a WebRTC peer connection, captures microphone audio, opens a data channel, creates an SDP offer, and posts that offer to `POST /session`. The backend validates that the body is an SDP offer, chooses a realtime model and voice, sends the offer to OpenAI's Realtime call API, and returns an SDP answer to the browser.

The realtime controller receives a compact tool surface. Its core tools are backend delegation, direct whiteboard command submission, and undo.

## 2. Realtime Produces Tool Calls

When the data channel receives Realtime events, `public/app.js` updates transcript lines for user and assistant speech. When a function call is complete, the browser sends the tool name, arguments, call id, and client session id to `POST /tools/execute`.

The browser also tracks handled call ids so a function call emitted through multiple event forms is only executed once.

## 3. Backend Routes The Tool

`server.js` handles `/tools/execute`. For orchestrator-style tool names, it retrieves session state, updates selected-item context when present, and calls the intent router. If the routed intent should use the whiteboard, the server can queue a whiteboard job immediately. Otherwise it delegates to the brain service.

Undo is handled directly through board state. Direct whiteboard commands are queued as jobs.

## 4. Brain Or Planning Produces Board Operations

The brain path normalizes intent and decides whether the turn is board-first. Board-first work goes through [[whiteboard-planning-and-jobs|Whiteboard Planning And Jobs]] ([Whiteboard Planning And Jobs](../concepts/whiteboard-planning-and-jobs.md)), which returns typed operations. Non-board work calls the configured brain model or the legacy flight workflow when the normalized task matches flight search.

Before mutation, operations are validated against [[board-operation-protocol|Board Operation Protocol]] ([Board Operation Protocol](../concepts/board-operation-protocol.md)). Valid operations are applied to the session board with an undo checkpoint.

## 5. Frontend Renders Or Polls

If the response includes `board_state`, the frontend renders it immediately. If the response includes `whiteboard_job`, the frontend starts polling `GET /board/jobs` every 900 ms. Completed jobs return board state and a spoken summary; failed or clarification-needed jobs show a system message.

User drag moves are not local-only. On pointer release, the browser sends a `move_item` operation to `POST /board/operations`, receives the updated board state, and keeps the move undoable.

## See Also

- [[project-overview|Project Overview]] ([Project Overview](project-overview.md)) - product and repository orientation.
- [[board-operation-protocol|Board Operation Protocol]] ([Board Operation Protocol](../concepts/board-operation-protocol.md)) - operation types, validation, state mutation, and undo.
- [[orchestration-and-model-routing|Orchestration And Model Routing]] ([Orchestration And Model Routing](../concepts/orchestration-and-model-routing.md)) - routing decisions behind this flow.

## Sources

- [TeamsForAI Repository README](../../raw/repos/2026-05-18-repository-readme.md) - expected product request sequence.
- [TeamsForAI Codebase Inventory](../../raw/repos/2026-05-18-codebase-inventory.md) - endpoints, frontend behavior, and module responsibilities.
