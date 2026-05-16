# TeamsForAI - Voice-Driven AI Whiteboard Protocol

Localhost web app that connects to the OpenAI Realtime API with voice input/output and turns complex spoken thinking into structured intent, brain reasoning, and typed board operations.

## What this includes

- **Express backend** with a secure `/session` endpoint
  - Uses your server-side `OPENAI_API_KEY`
  - Returns a short-lived ephemeral key to the browser
- **Plain HTML/CSS/JS frontend**
  - Connect/disconnect to Realtime
  - Microphone mute/unmute
  - Live transcript for user + assistant
  - Optional model field that overrides only the realtime controller model
- **Voice controller + router + brain split**
  - Realtime model acts as low-latency voice controller
  - Single high-level tool: `route_user_intent`
  - Backend router converts spoken goals into structured JSON intent
  - Backend Brain handles deeper reasoning and produces board operations
- **Milestone 1 board protocol**
  - Supports typed operations: `create_node`, `update_node`, `create_edge`, `create_group`, `move_item`, `emphasize_item`, `delete_item`, and `undo`
  - Stores board changes in an append-only operation log
  - Applies AI changes directly and exposes a visible Undo button
- **Milestone 2 DOM/SVG whiteboard**
  - Renders AI-created nodes as positioned cards
  - Renders relationships as SVG arrows
  - Shows visual group regions around related cards
  - Lets users drag cards and persists moves as undoable `move_item` operations

## Prerequisites

- Node.js 18+
- An OpenAI API key

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your env file:

```bash
copy .env.example .env
```

3. Edit `.env` and set:

```env
OPENAI_API_KEY=your_real_key_here
DEFAULT_REALTIME_MODEL=gpt-4o-realtime-preview
ORCHESTRATOR_MODEL=gpt-4.1-mini
BRAIN_MODEL=gpt-4.1-mini
WHITEBOARD_MODEL=gpt-4.1-mini
```

## Run

```bash
npm run dev
```

Then open:

`http://localhost:3000`

## Usage

1. Optionally enter a realtime model override, or leave the field blank to use `DEFAULT_REALTIME_MODEL`.
2. Click **Connect** and allow microphone access.
3. Speak and listen to model audio responses.
4. See transcript updates in the transcript panel.
5. Drag idea-map cards to reshape the board.
6. Use **Undo** to revert the latest AI or user board operation.
7. Use **Mute Mic** / **Disconnect** when needed.

## Test

```bash
npm test
```

On Windows PowerShell, use the command shim if script execution policy blocks `npm`:

```bash
npm.cmd test
```

### Example request

Try saying:

`Map the core idea for a voice-first AI whiteboard for startup founders.`

Expected behavior:

1. Realtime controller calls `route_user_intent`
2. Router returns structured intent for an `idea_map`
3. Brain creates typed board operations
4. Server applies the operations to session board state
5. UI renders the DOM/SVG whiteboard and enables Undo
6. Realtime controller speaks the concise `spoken_summary`

You can drag any generated card. On drop, the browser sends a `move_item` operation to the server, receives updated board state, and keeps the move undoable.

### Delegation criteria (cost control)

Controller should delegate when task requires:

- more than one reasoning step
- long-form generation
- structured planning
- whiteboard or idea-map changes
- external synthesis/tool orchestration
- non-voice workflow actions

Controller should answer directly for short/simple conversational turns.

## Notes

- Keep your real API key only in `.env` (never client-side).
- Realtime event formats can evolve; this demo handles common transcript + function-call events and is intentionally minimal.
- Keep controller prompt/tool schema small to reduce realtime token cost.
- Brain orchestration lives in `lib/brainService.js`.
- Routing lives in `lib/intentRouter.js`.
- Board state and undo live in `lib/boardState.js`.
- User-originated board operations are handled by `POST /board/operations`.
- The older mock flight workflow remains available in backend code, but the active product path is the AI whiteboard protocol and DOM/SVG board.
