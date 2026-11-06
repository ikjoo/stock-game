# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Virtual stock-investment game (Korean UI). Zero dependencies: Node's built-in `node:sqlite` (needs a recent Node, developed on v26) plus the plain `http` module. No package.json, build, or lint setup exists; tests use the built-in `node:test`.

## Commands

- Run: `npm start` / `node server.js` (or double-click `start.bat`, which also opens the browser). Serves http://localhost:3456; override with the `PORT` env var. Port 3000 is occupied by another program on this machine.
- Test: `npm test` (= `node --test test/`; single test: `node --test --test-name-pattern="랭킹" test/`). The tests in `test/api.test.js` are black-box: they spawn `server.js` on a free port chosen by the OS with a temp SQLite file (via the `DB_PATH` env var) and only use HTTP, so they should keep passing unchanged through internal refactors. Keep the HTTP API shape (`view()` fields, status codes) stable or update the tests deliberately. The frontend has no automated tests.
- The server must be restarted after editing anything under `src/` or `server.js`. Files in `public/` are read from disk per request, so just refresh the browser.
- Reset all data: stop the server and delete `game.db` (plus `game.db-wal`/`game.db-shm`); tables are recreated on startup.

## Architecture

Backend (`server.js` is only the entry point), layered so each file only depends on the ones below it:

- `src/config.js`: env (`PORT`, `DB_PATH`) and all game constants (`START_MONEY`, `START_PRICE`, `TOTAL_TURNS`, price-change range, the `STOCKS` list).
- `src/db.js`: SQLite connection, schema creation, `all/get/run` helpers and `tx()` (`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`).
- `src/game.js`: all game rules (`startGame`, `buy`, `sell`, `endTurn`, `rankings`, `view`). It knows nothing about HTTP; validation failures throw `HttpError(status, message)` from `src/errors.js` with Korean messages shown directly in the UI.
- `src/ai.js`: AI 매매 추천. OpenRouter(`OPENROUTER_API_KEY`, 선택 `OPENROUTER_MODEL`/`OPENROUTER_BASE_URL`; `.env`에서 읽음, git 제외)를 서버에서만 호출하고, 응답은 `sanitize()`로 현금/보유량에 맞게 검증한다. `POST /api/ai/recommend`는 상태를 바꾸지 않으며, 클라이언트가 추천을 기존 buy/sell API로 실행한다. 테스트는 `test/ai.test.js`(가짜 OpenRouter 서버 사용).
- `src/app.js`: HTTP only: route table, JSON body parsing, error to status mapping, static file serving from `public/`. POST requests must use `Content-Type: application/json` (415 otherwise), bodies are capped at 10KB (413), and malformed JSON or non-object bodies return 400.

Frontend (`public/`, native ES modules, no build step): `index.html` + `style.css`, with `js/main.js` (state, rendering, events), `js/chart.js` (hand-built inline SVG chart), `js/util.js` (DOM/format/fetch helpers, `escapeHtml`).

Key behaviors:

- The server is the source of truth. Every endpoint returns or derives from `view(gameId)`, and the client just re-renders that object. Add new state to `view()` and read it in `renderGame()`.
- Prices are generated and stored server-side per game in the `prices` table (one row per game, stock, turn). `endTurn` inserts the next turn's prices. Do not generate prices on the client, since reloading would let players reroll them.
- Finishing: `endTurn` on the last turn liquidates all holdings at current prices, sets `games.status='finished'`, and inserts into `rankings` (unique per `game_id`). Rankings are ordered by `final_money DESC` and are persistent, so never delete from `rankings` in normal operation.
- Every state-changing action runs inside `tx()`; keep new writes inside it.
- The client stores only the current `game.id` in `localStorage` (`stockGame.gameId`) and restores the game via `GET /api/game/:id` on load while its status is `playing`; the key is cleared when the game finishes.
- `games.traded` records whether a buy or sell happened this turn. The client uses it to show the "no trades, really end turn?" `confirm()` dialog. It is reset on each turn change.
