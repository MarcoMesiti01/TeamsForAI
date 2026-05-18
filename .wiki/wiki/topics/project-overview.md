---
title: "Project Overview"
category: topic
sources:
  - "raw/repos/2026-05-18-repository-readme.md"
  - "raw/repos/2026-05-18-codebase-inventory.md"
created: 2026-05-18
updated: 2026-05-18
tags: [teamsforai, project-overview, architecture, whiteboard]
aliases: [TeamsForAI, Voice-Driven AI Whiteboard Protocol]
confidence: high
volatility: warm
verified: 2026-05-18
summary: "High-level guide to TeamsForAI as a voice-first AI whiteboard app and how its main backend, frontend, and test areas fit together."
---

# Project Overview

> TeamsForAI is a localhost voice-first AI whiteboard. The browser captures speech through the OpenAI Realtime API, the backend decides whether a turn needs deeper reasoning or board work, and the frontend renders the resulting typed board operations as draggable DOM/SVG whiteboard content.

## What The App Does

The active product path is an AI whiteboard protocol. A user speaks an idea, plan, comparison, architecture question, or other thinking task. The realtime controller handles low-latency voice interaction, then delegates structured work to the backend. The backend routes intent, invokes deeper reasoning or whiteboard planning, applies typed board operations, and returns state for the browser to render.

The older mock flight workflow still exists in `lib/flightTools.js`, but the README identifies it as legacy. Treat it as a retained backend capability, not the main product.

## Main Areas

- `server.js` is the application boundary. It hosts the frontend, creates Realtime sessions, receives tool calls, manages per-client session state, exposes board endpoints, and applies or queues board changes.
- `lib/` contains the product logic. The important clusters are routing and orchestration, brain delegation, board state, board validation, board context, whiteboard command handling, whiteboard planning, async jobs, model policy, and legacy flight tools.
- `public/` contains the browser experience. It connects to Realtime, sends tool calls to the backend, renders board state, polls jobs, saves user drag moves, and supports undo.
- `test/` documents expected behavior through focused tests for routing, planning, validation, board state, jobs, brain integration, model policy, and frontend layout.

## How To Read The Code

Start with [[runtime-request-flow|Runtime Request Flow]] ([Runtime Request Flow](runtime-request-flow.md)) to understand the lifecycle of a spoken request. Then read [[board-operation-protocol|Board Operation Protocol]] ([Board Operation Protocol](../concepts/board-operation-protocol.md)) because most visible behavior becomes typed board operations. After that, use [[code-navigation-guide|Code Navigation Guide]] ([Code Navigation Guide](../references/code-navigation-guide.md)) as a file-by-file map.

## See Also

- [[runtime-request-flow|Runtime Request Flow]] ([Runtime Request Flow](runtime-request-flow.md)) - end-to-end behavior from voice to rendered board.
- [[orchestration-and-model-routing|Orchestration And Model Routing]] ([Orchestration And Model Routing](../concepts/orchestration-and-model-routing.md)) - backend decision layer and model selection.
- [[whiteboard-planning-and-jobs|Whiteboard Planning And Jobs]] ([Whiteboard Planning And Jobs](../concepts/whiteboard-planning-and-jobs.md)) - async whiteboard planning and polling.
- [[code-navigation-guide|Code Navigation Guide]] ([Code Navigation Guide](../references/code-navigation-guide.md)) - practical file map.

## Sources

- [TeamsForAI Repository README](../../raw/repos/2026-05-18-repository-readme.md) - product intent, setup, active workflow, and usage model.
- [TeamsForAI Codebase Inventory](../../raw/repos/2026-05-18-codebase-inventory.md) - observed file structure, endpoints, modules, and tests.
