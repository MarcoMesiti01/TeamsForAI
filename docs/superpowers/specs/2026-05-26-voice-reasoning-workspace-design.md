# Voice-First Reasoning Workspace: Milestone 1 Design

## Purpose

TeamsForAI began as a voice-driven visual whiteboard for organizing ideas. The first development milestone will make it behave as a coherent reasoning system during a live voice session, before adding formal decision analysis or action planning.

The primary user problem is not a missing diagram type. It is discontinuity: spoken interaction, deeper reasoning, and board updates feel disconnected and do not reliably preserve what the user and system have established together.

Milestone 1 addresses this by introducing a shared reasoning workspace that is the authoritative center of each substantive voice interaction.

## Scope And Sequence

The agreed product sequence is:

1. Stabilize the reasoning and visual interaction loop through a shared workspace.
2. Add structured decision analysis for evaluating options and trade-offs.
3. Add operational action planning derived from reasoning and decisions.

This document specifies only milestone 1.

## Product Outcome

During one live voice session, a user can discuss a problem, see inferred structured memory and a matching visual representation, refer back to prior ideas in follow-up speech, correct retained assumptions or conclusions by voice, and observe the ledger and board reconcile.

Voice is the primary acceptance channel. A typed-only implementation is not sufficient for completing this milestone.

## Core Principles

- The shared reasoning workspace, not the board alone, is the system's session memory.
- The voice assistant remains natural and responsive, but substantive work is coordinated through shared state.
- The visual board is a projection of the reasoning workspace, not the full source of truth.
- The system may commit inferred knowledge automatically, but commits must be visible, attributable, and reversible.
- Milestone 1 is domain-general: it supports reasoning continuity rather than embedding architecture, finance, consulting, or supply-chain-specific methods.

## Architecture

### Existing Components To Retain

The current system already contains useful foundations:

- Realtime voice controller and backend tool calls.
- Orchestrator/model policy separation.
- Reasoning and whiteboard planning services.
- Typed board operations, asynchronous board jobs, and visual undo.
- Per-session in-memory state.

Milestone 1 extends these boundaries rather than replacing the application.

### New Center: Reasoning Workspace

Each active voice session owns an in-memory `ReasoningWorkspace`. It is read by the realtime interaction layer through compact briefings, by the turn coordinator for each substantive turn, by the reasoning model, and by the whiteboard planner.

The workspace contains two layers:

#### Working Memory

Working memory is the rapidly changing conversational layer. It may contain:

- Current topic or question.
- Recent-turn summary.
- Candidate options under discussion.
- Provisional observations and hypotheses.
- Unresolved references, such as "that option."
- Current visual or board focus.

It supports fast conversational continuity and is not treated as definitive truth.

#### Committed Workspace

Committed workspace is authoritative session knowledge that future reasoning can rely on. It contains categorized entries for:

- Problem statement.
- Objectives.
- Constraints.
- Assumptions.
- Options.
- Decision criteria.
- Decisions.
- Open questions.

Each committed entry records its category, content, origin, status, source turn, and change history. Origin distinguishes at minimum `user_stated` and `ai_inferred`. Status supports pending, active, corrected, removed, and superseded content without silently erasing prior state. An entry is `active` only after its workspace operation has been validated and applied.

The workspace lasts only for the live browser session in milestone 1. Reopening a saved workspace is deferred.

### Turn Coordinator

A new workspace-centered turn coordinator owns substantive voice turns. The realtime speaker remains an independent speaker for natural turn-taking and trivial interactions, while the coordinator makes meaningful reasoning coherent.

A turn is substantive when it involves:

- Analysis, comparison, planning, design, explanation, or synthesis.
- Recall or interpretation of existing workspace knowledge.
- Creation, correction, or removal of a committed entry.
- A visual artifact or change to an existing board structure.
- A user reference that must be resolved against workspace or board context.

The independent speaker may respond directly to greetings, connection feedback, repeat requests, and short interface guidance. It receives an updated compact workspace briefing so even direct speech remains aware of the current activity.

## Coordinated Voice Turn Flow

For each substantive spoken turn:

1. The realtime controller submits the utterance, compact spoken context, and any selected or referenced visual item to the coordinator.
2. The coordinator grounds the turn against working memory, committed workspace, and the current board snapshot.
3. Working memory is updated with recent context, provisional interpretations, relevant options, and unresolved questions.
4. Relevant durable content is automatically promoted into committed workspace with provenance and a reversible change record.
5. The deeper reasoning model receives both state layers and returns a grounded substantive response, implications, uncertainties, and suggested next examination.
6. The whiteboard planner receives the relevant workspace changes and reasoning output, then refines or updates the visual board to reflect current state.
7. The realtime assistant speaks a concise response. When useful, it briefly signals that a fact, assumption, criterion, or decision has been captured or changed.
8. A fresh compact workspace briefing is made available to subsequent voice interaction.

Longer reasoning and visual synchronization may run asynchronously after a rapid acknowledgement. Pending and failed states remain visible in the interface.

## Automatic Commitment And Correction

The user selected automatic commitment with correction instead of requiring confirmation for every promotion. This supports fluid exploration, but requires stronger controls.

### Commit Rules

- The system may automatically create committed entries when it identifies information relevant to future reasoning.
- AI-inferred entries must be labeled distinctly from user-stated entries.
- Entries must preserve their originating turn or utterance reference.
- Promotion to committed state must be exposed in the UI, and may be acknowledged briefly in speech.

### Correction Rules

Voice corrections are first-class workspace operations. Examples include:

- "That is not a constraint, only a preference."
- "Remove the assumption about cloud hosting."
- "We have not decided yet; keep both options open."
- "Undo the last conclusion."

Correction must update committed state, preserve traceability, inform later reasoning, and trigger board synchronization where the visual representation changed.

Reasoning undo is distinct from existing board undo. Board undo reverses visual operations; reasoning undo changes what the system treats as session knowledge. The UI should make the distinction understandable while allowing both.

## User Experience

The voice-first experience is represented through three synchronized surfaces.

### Conversation Surface

The user speaks naturally and receives concise spoken responses grounded in the current workspace. The assistant may acknowledge newly retained state without repeatedly requesting confirmation.

### Workspace Ledger

A new visible panel exposes authoritative session knowledge under the following categories:

- Problem.
- Objectives.
- Constraints.
- Assumptions.
- Options.
- Criteria.
- Decisions.
- Open questions.

Ledger entries communicate whether content was user-stated or AI-inferred and whether it is pending, active, corrected, removed, or superseded. The ledger exposes correction and undo status so users can inspect what the system believes.

### Visual Board

The existing board displays spatial reasoning artifacts derived from the shared workspace. It may show exploratory material from working memory, but tentative content must be visibly distinct from committed knowledge.

The planner should refine existing related structures when users follow up, rather than defaulting to unrelated new diagrams. Board changes remain typed and undoable.

## State And Operation Boundaries

Milestone 1 should introduce explicit workspace operations, conceptually including:

- Update working-memory summary or focus.
- Add committed entry.
- Correct or reclassify committed entry.
- Supersede or remove committed entry.
- Undo the latest committed-workspace change.

The exact wire format is deferred to implementation planning, but the boundary must keep state changes deterministic, inspectable, and testable. Model output should propose structured operations; application code should validate and apply them.

Board operations remain separate from workspace operations. Board state reflects reasoning state but does not replace it.

## Failure Handling

- If a proposed workspace operation cannot be validated and applied, no new entry may be displayed as active committed knowledge.
- If an entry has been validly committed but later reasoning-response generation fails, the committed entry remains visible and the UI reports the response failure separately.
- If a committed update succeeds but visual synchronization fails, committed workspace remains authoritative and the interface reports that the board is out of sync or pending retry.
- Invalid workspace operations must be rejected without corrupting existing state.
- If a correction cannot be mapped safely to a committed item, the assistant should ask a focused clarification rather than changing authoritative state.
- If asynchronous work is in progress, the user must receive a prompt acknowledgement and visible progress state.

## Testing And Acceptance Criteria

### Automated Coverage

Tests should cover:

- Creation and isolation of an in-memory reasoning workspace per session.
- Working-memory updates and compact briefing generation.
- Committed entry creation with user-stated or AI-inferred provenance.
- Correction, reclassification, superseding, removal, and reasoning undo.
- Coordinator flow for substantive voice tool calls.
- Separation of trivial direct speech from coordinated reasoning work.
- Failure behavior for invalid commits, failed reasoning, and failed board synchronization.
- Board planning from workspace changes and refinement of existing visual structures.
- Ledger rendering for categories, provenance, statuses, and pending/failure states.

### Manual Voice Acceptance Scenario

The milestone is accepted when a live voice session can demonstrate the following domain-general flow:

1. The user introduces a problem requiring structured thought.
2. The assistant gives a useful grounded response and the UI shows structured memory and a matching board update.
3. The user follows up by referring to previously discussed content without restating it.
4. The response and visual changes correctly use the existing workspace rather than starting an unrelated artifact.
5. The user corrects an assumption or conclusion by voice.
6. The ledger records the correction, later reasoning respects it, and the board reconciles accordingly.

## Deferred Capabilities

Milestone 1 does not include:

- Durable storage or restoring workspaces after session end.
- Formal decision matrices, scoring, or recommendation workflows.
- Operational plans with milestones, owners, dependencies, or progress tracking.
- Domain-specific reasoning templates.
- A continuous multi-agent autonomous loop.

These are follow-on capabilities that depend on a trustworthy shared reasoning workspace.
