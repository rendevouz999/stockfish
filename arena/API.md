# Arena API (local only)

Base: `http://127.0.0.1:8124` unless the operator selected another port.

All API calls require `Authorization: Bearer <matching session capability>`. Never send a capability in a URL query string. POST requests require a JSON object and `Content-Type: application/json`. Bodies are limited to 1 MiB. The player and observer capabilities are **different**; neither substitutes for the other. No CORS access is granted.

| Method/route | Role | Purpose |
|---|---|---|
| GET `/api/player/state` | player | Current board and own legal moves |
| POST `/api/player/move` | player | Submit an idempotent move |
| GET `/api/observer/state` | observer | State, game summaries, full events, diagnostic |
| GET `/api/observer/player-link` | observer | Private current player URL; never available to player or anonymous callers |
| POST `/api/observer/start` | observer | Validate config and start a new game |
| POST `/api/observer/reset` | observer | Preserve prior game and return to idle |
| POST `/api/observer/review` | observer | End active game with result `*` for review |
| POST `/api/observer/memory/import` | observer | Import unverified external telemetry |
| GET `/api/observer/export?format=json` | observer | JSON export |
| GET `/api/observer/export?format=jsonl` | observer | Journal-format export |
| GET `/api/observer/export?format=pgn` | observer | PGN export |

Exports accept optional `&game_id=<recorded-game-uuid>`. Unknown routes, including hint/evaluation endpoints and engine/log source paths, return 404. Wrong or missing capabilities return 403/401. Domain validation errors return 400, rejected player moves return 409 with the current state, and journal failure returns 503.

## Player state

State includes `game_id`, `generation`, `version`, `decision_id`, `phase`, `status`, `turn`, `player_color`, `fen`, `ply`, public SAN/UCI `moves`, own `legal_moves`, `result`, and `reason`. No engine evaluation/PV/configuration or private Memory content is included.

`generation` changes across starts/resets. `version` is the accepted-move count within a game. Phase/status may change without a move version increment; browser clients must reject older responses at the same version, particularly after review or engine failure. `decision_id` identifies a turn, including rejected attempts that did not advance it. Player legal moves are empty outside the player's active turn.

## Move body

```json
{
  "request_id": "new-UUID-per-intended-move",
  "game_id": "copy-from-current-state",
  "generation": 1,
  "version": 0,
  "decision_id": "copy-from-current-state",
  "from": "e2",
  "to": "e4"
}
```

Promotion must explicitly add `"promotion": "q"`, `"r"`, `"b"` or `"n"` and must match a legal promotion move. Omit it for ordinary moves. `request_id` permits 1–128 ASCII letters, digits, underscores or hyphens. Use a fresh UUID for a new intention, but retain the **same ID and complete body** for uncertain network retries. The exact same request returns its original response; a changed body with the same ID yields `request_id_conflict`. Do not interpret a cached older response as the current board. Poll state after resolving an uncertain request.

Response: `{ "ok": true|false, "code": "move_accepted"|reason, "state": {...} }`.

Representative rejections: `game_not_active`, `stale_state`, `not_player_turn`, `invalid_square`, `promotion_required`, `invalid_promotion`, `illegal_move`. There is no fallback player move.

## Start body

```json
{
  "player_color": "w",
  "skill_level": 5,
  "movetime_ms": 300,
  "training_label": "baseline-session"
}
```

Defaults are shown. Color is `w` or `b`; skill is an integer 0–20; move time is an integer 50–2000 ms. Optional `initial_fen` must be a valid chess.js standard-chess position. Custom positions should be recorded and matched in comparisons. Validating a bad new configuration does not end or replace the current game. A valid start replaces an active game with a recorded `operator_replaced` result `*`.

Reset and review bodies are `{}`. Use the operator UI once for these commands; unlike player move requests, operator controls do not provide request-ID deduplication. If a response is lost, poll observer state before retrying.
