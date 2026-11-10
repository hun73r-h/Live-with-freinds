# Live with frens — AI coding guidelines

This project follows the Karpathy-inspired principles from:
https://github.com/multica-ai/andrej-karpathy-skills

The goal is to keep the app simple, reliable, and easy to reason about while working on a small real-time WebRTC watch-party project.

## Core principles

### 1. Think before coding
- State assumptions clearly before changing room logic, signaling, or WebRTC behavior.
- If a bug could be caused by network conditions, browser permissions, or room state, name that possibility explicitly instead of guessing.
- If there are multiple valid approaches, present the tradeoff briefly and choose the simpler one.
- When requirements are unclear, ask rather than silently inventing behavior.

### 2. Simplicity first
- Keep this project lightweight: no auth, no database, no unnecessary backend complexity unless specifically requested.
- Prefer small, readable changes over large abstractions.
- Do not add configuration layers or extra modules for a single-use feature.
- If a fix can be done in a few lines without harming clarity, prefer that over a generalized framework.

### 3. Surgical changes
- Touch only the files required for the requested behavior.
- Preserve existing room flow, naming patterns, and UI conventions.
- Do not refactor unrelated code or “clean up” nearby sections unless the task specifically requires it.
- If a change creates unused variables, imports, or dead code, remove only what your own edit introduced.

### 4. Goal-driven execution
- Define the success condition before implementing.
- Verify with the smallest relevant check: server start, browser smoke test, or a targeted code path.
- For bug fixes, prefer a focused reproduction check over broad testing.

## Project-specific guidance

### Browser and WebRTC behavior
- This app is built around real-time peer communication in small rooms.
- Prefer minimal changes to signaling, peer connection setup, ICE handling, and room state management.
- Be careful not to break screen share, mic toggling, chat, or join/leave flows while fixing other issues.
- When adding TURN or relay logic, keep it server-side and avoid exposing secrets to the browser.

### Server-side expectations
- `server.py` is a lightweight signaling server and static file host.
- Keep the server behavior predictable; avoid adding database or auth infrastructure unless explicitly required.
- If the task impacts public internet deployment, consider TURN/STUN constraints and hosting environment.

### Frontend expectations
- `app.js` holds most of the app logic; keep event handling and room state transitions clear.
- Respect the current UI patterns for creating rooms, joining rooms, chat, participant management, and media permissions.
- For UI updates, prefer incremental state changes over broad rewrites.

## Working style for this repo

Before making a change, briefly confirm:
1. What is the actual bug or missing behavior?
2. Which files are directly involved?
3. What is the smallest check that proves the fix works?

When implementing:
- make the smallest possible patch
- keep naming and structure consistent with the existing code
- avoid speculative features or redesigns
- verify the app still runs locally

## Minimal verification

For this repo, a basic validation is usually:
- start the app with `python3 server.py`
- confirm the site loads on `http://localhost:8000`
- smoke-test the affected flow (room create/join, mic toggle, chat, or screen share as relevant)

## Practical reminder

This is not a large-scale SaaS application. The best solutions are often the simplest ones that preserve the current room-based realtime architecture.
