---
title: "Orchestration And Model Routing"
category: concept
sources:
  - "raw/repos/2026-05-18-codebase-inventory.md"
  - "raw/repos/2026-05-18-repository-readme.md"
created: 2026-05-18
updated: 2026-05-18
tags: [orchestration, routing, models, realtime, brain]
aliases: [Intent Routing, Model Policy]
confidence: high
volatility: warm
verified: 2026-05-18
summary: "Explains how TeamsForAI separates realtime voice UX from backend orchestration, model role selection, deterministic fallback routing, and brain delegation."
---

# Orchestration And Model Routing

> TeamsForAI separates fast voice control from deeper backend decisions. The realtime model decides when to call tools, while backend routing chooses whether the request is conversational, board-first, clarification, tool work, or undo.

## Role Split

The realtime controller is optimized for low-latency voice interaction. It should answer simple conversational turns directly, but delegate thinking work, planning, mapping, comparisons, architecture, and board changes.

The backend orchestrator receives compact conversation context, compact board context, available capabilities, visible board context, and the current user goal. It returns a normalized decision with intent type, artifact type, board strategy, route action, confidence, required context, preferred model, and optional board command.

## Fallback Routing

The orchestrator can call a model-backed decision service, but it also has deterministic fallback logic. The fallback recognizes explicit undo requests, board-worthy thinking tasks, and simple conversational turns. It also chooses artifact types such as process flow, architecture map, comparison map, action plan, idea map, or conversation.

This is important for local development: missing or unavailable API access does not make routing completely opaque. Tests cover many fallback paths.

## Model Policy

`lib/modelPolicy.js` defines roles for realtime controller, orchestrator, brain reasoner, whiteboard planner, and summarizer. Each role maps to a specific environment variable and fallback model. Services ask for a model by role plus complexity, latency budget, and artifact type.

The repository currently treats model policy as central configuration rather than scattering model names through every service.

## Brain Delegation

`lib/brainService.js` receives normalized intent. Board-first turns go through the whiteboard planner and board validator. Non-board turns call the brain model for strict JSON with spoken summary, full response, reasoning summary, and missing info. Flight-like tasks are intercepted by the legacy mock flight workflow.

## See Also

- [[runtime-request-flow|Runtime Request Flow]] ([Runtime Request Flow](../topics/runtime-request-flow.md)) - where routing sits in the request lifecycle.
- [[whiteboard-planning-and-jobs|Whiteboard Planning And Jobs]] ([Whiteboard Planning And Jobs](whiteboard-planning-and-jobs.md)) - downstream board planning after a board-first route.
- [[project-overview|Project Overview]] ([Project Overview](../topics/project-overview.md)) - product-level orientation.

## Sources

- [TeamsForAI Codebase Inventory](../../raw/repos/2026-05-18-codebase-inventory.md) - responsibilities of orchestrator, intent router, model policy, and brain service.
- [TeamsForAI Repository README](../../raw/repos/2026-05-18-repository-readme.md) - voice controller, router, and brain split.
