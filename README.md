# TeamsForAI - OpenAI Realtime Voice Demo (Controller + Brain)

Simple localhost web app that connects to OpenAI Realtime API with voice input/output and live transcript, using a two-tier agent architecture.

## What this includes

- **Express backend** with a secure `/session` endpoint
  - Uses your server-side `OPENAI_API_KEY`
  - Returns a short-lived ephemeral key to the browser
- **Plain HTML/CSS/JS frontend**
  - Connect/disconnect to Realtime
  - Microphone mute/unmute
  - Live transcript for user + assistant
  - Model field so you can choose model in UI
- **Controller + Brain split**
  - Realtime model acts as low-latency voice controller
  - Single high-level tool: `delegate_to_brain`
  - Backend Brain handles deeper reasoning and non-realtime tasks
- **Flight workflow behind Brain**
  - Brain uses `searchFlights` over mock live-like data
  - Brain persists results via `saveFlightsToFile` into `flights found.txt`

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
BRAIN_MODEL=gpt-4.1-mini
```

## Run

```bash
npm run dev
```

Then open:

`http://localhost:3000`

## Usage

1. Enter a realtime model in the model field (or keep default).
2. Click **Connect** and allow microphone access.
3. Speak and listen to model audio responses.
4. See transcript updates in the transcript panel.
5. Use **Mute Mic** / **Disconnect** when needed.

### Example request

Try saying:

`What flights are the cheapest on 2026-05-15 from Milan to Brussels?`

Expected behavior (controller delegates to brain):

1. Realtime controller calls `delegate_to_brain`
2. Brain classifies task as flight-related
3. Brain searches cheapest options in mock dataset
4. Brain writes output to `TeamsForAI/flights found.txt`
5. Realtime controller speaks concise summary back

### Delegation criteria (cost control)

Controller should delegate when task requires:

- more than one reasoning step
- long-form generation
- structured planning
- external synthesis/tool orchestration
- non-voice workflow actions

Controller should answer directly for short/simple conversational turns.

## Notes

- Keep your real API key only in `.env` (never client-side).
- Realtime event formats can evolve; this demo handles common transcript + function-call events and is intentionally minimal.
- Keep controller prompt/tool schema small to reduce realtime token cost.
- Current flight provider is a mock dataset; swap in real provider inside `lib/flightTools.js`.
- Brain orchestration lives in `lib/brainService.js`.
