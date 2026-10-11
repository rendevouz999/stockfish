# Quiet Chess Observation Arena

A separate **local, no-VM arena** for observing a restricted browser chess player against server-side Stockfish. The upstream static Quiet Chess application is preserved. This entry does **not** run its hint/evaluation features or its browser engine.

## Start on Windows

Requirements: Node.js **20 or newer**; Node.js 24 LTS recommended. Git is useful for cloning. No API keys, model accounts, global installs, VM, npm dependencies, or Agent Core changes are needed to run the arena.

From CMD in this checkout:

```cmd
node --version
npm test
npm run arena
```

Alternatively double-click `start-arena.cmd`. It changes into the repository's own directory before starting. Leave the console open. Press Ctrl+C to stop.

The server binds **127.0.0.1 only**, by default on port **8124**, and prints two different capability links:

- `/player#token=...`: the playing board. Give only this link to the restricted player controller.
- `/observer#token=...`: operator controls, event timeline, Memory import and exports. Keep this link and the server console private from the player.

Open the observer, choose player color, Stockfish skill 0–20 and engine move budget, and press **Start game**. Open the player link, click a piece and its legal destination. Promotion requires an explicit queen, rook, bishop or knight selection. The player can only submit its own legal moves. The opponent is real bundled Stockfish running in a separate Node process on the same computer.

Links last for one server session. Each page retains its private capability in the URL fragment so refreshing the same tab reconnects without copying a link from the console. Treat the complete address as a credential: browser history may retain it. The app does not add cookies, localStorage, sessionStorage, or token files. Restarting the server invalidates old links. Do not put capability links in public screenshots, reports, chat transcripts or Git.

The observer provides an authenticated **Open Player** link for the current server session. The player capability never grants observer control. Starting another game does not require restarting the server. Use the observer game controls; reset returns to idle, while restarting a game preserves earlier evidence.

Custom port or independent journal directory:

```cmd
npm run arena -- --port 8125 --data-dir "E:\Projects\Quiet-Chess-Data"
start-arena.cmd --port 8125
```

### Automatically open your existing portable Brave

Double-click **`start-arena-brave.cmd`**. It uses the confirmed **`F:\Brave-Isolated`** folder only if **`App\brave.exe`** exists there. Otherwise it prompts for the existing portable Brave folder, without surrounding quotes. The launcher starts the server first, then asks that Brave executable to open the observer and player tabs. Keep the console open. The original `start-arena.cmd` remains the manual, no-auto-open option.

The batch launcher does not interpolate command-line path arguments. For a scripted override, use `npm run arena -- --open --browser brave --brave-root "YOUR_EXISTING_PORTABLE_FOLDER"` after replacing that placeholder with its actual absolute Windows folder. The default is the owner-confirmed location; another location must be supplied explicitly. Only the Brave option is supported. No installed/system browser is used as a fallback.

This matches the supported portable layout: `App\brave.exe`, `UserData`, `Cache`, `CrashDumps`, `Temp`, `Downloads`, `AppData\Local`, `AppData\Roaming`, and `Profile`. After checking that the existing executable is present, the launcher creates missing scoped data directories and passes the profile/cache/crash paths as separate arguments. Its child environment points TEMP/TMP, LOCALAPPDATA/APPDATA and HOME/USERPROFILE into that same root; HOMEDRIVE and HOMEPATH are derived from the actual selected drive and profile path. It does not rewrite the parent environment or persistent Windows settings. Preparing `Downloads` does not change Brave's download preference.

No browser install, extension, remote-debugging port, profile migration or default-browser change is performed. The existing Brave executable decides whether to reuse its current process/window for that UserData folder; the currently focused profile or tab cannot be guaranteed. Portable data-directory redirection is **not** an OS sandbox. Both tabs open for operator setup; restrict the player controller to the player surface before a scored match.

If the folder is incorrect, Brave cannot launch, or the OS is unsupported, the server stays available and prints manual capability links. Opening a process is only a launch request, not proof the page loaded. Actual Windows/Brave launch and browser interaction remain separate checks on the user's machine. The confirmed default root is in the generic launcher; capability tokens are never saved into it or the repository.

Use a separate data directory for each concurrent server. Do not kill unrelated processes to free a port. The default `arena-data/` directory and the suggested `arena-reports/` / `arena-exports/` directories are Git-ignored. Data elsewhere must be protected separately.

The [Windows installation handoff](../docs/RDC-WINDOWS-HANDOFF.md) provides a bounded Remote Desktop Commander workflow. Windows installation itself has not been performed by this cloud build.

## What is measured

The operator controls configuration, start, reset and ending a session for review. The player cannot perform these actions. A normal game starts in `training` and enters `review` at checkmate/draw, or when the operator ends it. Reset returns the live board to idle and preserves prior records.

Each game has a UUID; each turn has a decision UUID. A submitted player move must match the current game, generation, version and decision, in addition to passing chess legality and player-color checks. Every request has an idempotency ID. An identical retry returns the original receipt; reusing the ID for a different move is rejected. A reset or replacement invalidates pending engine searches, and stale engine results cannot alter the new board. An engine failure pauses the game; no fallback move is invented for either actor.

`arena-data/events.jsonl` is an append-only, fsync-backed local journal. Events include:

- UTC timestamp, sequence number, server session and session-relative monotonic timestamp
- `game_id`, `generation`, `decision_id`, ply and actor
- FEN before/after, SAN/UCI for accepted moves
- Configuration, `position_ready`, `action_received`, accepted/rejected actions and their reasons, engine searches/errors, reset and game result
- Memory import provenance and local import receipts

`ready_to_action_ms` measures server position-ready → server action-received. It includes polling, rendering, network, tools, controller work and thinking. It is **not pure reasoning time**. `action_to_accept_ms` covers the server validation stage; `engine_wall_ms` includes engine startup and search. Different server-session monotonic clocks are not comparable. Claimed Memory source time is `memory.occurred_at`; the server's receipt time is the enclosing `timestamp_utc`.

Only submissions reaching the server are recorded. Selecting a piece, cancelling a promotion, clicking a disabled target or an illegal attempt suppressed locally is not a submitted move and is not counted as one.

On restart, the journal is validated and chess moves are replayed. Historical games/receipts remain available. An interrupted active game becomes review with `server_restart`, and the operator starts a new game. The server never resumes unattended play. A malformed or incomplete journal fails closed rather than silently discarding records; preserve it and inspect/repair a **copy** before selecting a new data directory. The log is not cryptographically tamper-evident. The single-writer lock prevents concurrent writes to the same journal. An existing lock always blocks startup, even if its recorded PID appears dead, to avoid racing another starter. After an abnormal process exit, verify that no arena process is using this exact data directory, preserve the journal and lock, then manually remove only that confirmed stale `events.jsonl.lock` before one restart. Never remove an unknown/live lock or the journal. Selecting a fresh data directory is the non-destructive alternative.

## Observer and exports

The observer displays game state, a chronological timeline, raw event details, Memory-import controls and a five-game evidence checkpoint. Export **JSON**, **JSONL**, or **PGN** through its authenticated buttons. JSON/JSONL preserve telemetry; PGN preserves chess moves/results, not Memory events. The API can select one game with `game_id`.

The checkpoint includes the latest five naturally finished games that each contain at least one player move. Empty loaded checkmates, resets, replacements, restarts and operator-aborted games do not satisfy it. It reports observed counts, response-window timing and data limitations. It does not declare learning, score causation, invent retrieval success, or calculate unmeasured engine accuracy/blunders. Different strength, colors or custom FEN configurations remain visible and should be matched before comparisons.

After five suitable games, inspect: whether experiences were actually recorded; whether relevant retrieval IDs recur at later decisions; whether lesson versions changed with explicit provenance; and whether those changes correspond to better choices under matched conditions. An imported “lesson applied” assertion alone is not proof that it affected a move.

## Memory telemetry: no integration claim

**No live Agent Core Memory bridge is installed.** The empty default means no Memory evidence has been received. The arena can ingest external telemetry using the operator's JSON import form or authenticated import API. It neither reads production Memory nor writes lessons into it. Live integration requires separate authorized work.

Every imported record is permanently labelled `imported_unverified`. `receipt_status: local_import_recorded` proves only that this server accepted the import. It does not verify that a retrieval happened, a lesson was learned or the source was honest. Input cannot self-assert `verified` or `verification`. There are no verified Memory records in this version.

See [MEMORY-SCHEMA.md](MEMORY-SCHEMA.md) for the strict import format and [API.md](API.md) for routes.

## Trust boundary

This is application-level separation for a **restricted player controller**, not an OS sandbox or adversarial anti-cheating system. A controller with arbitrary host shell/filesystem access, unrestricted browsing/tabs, observer capability, or a separate engine can bypass it. Do not call that a scored fair match. The operator/RDC installation session has broader permissions than a playing session and must remain separate.

The arena server:

- Serves only five explicitly allowed UI files; never the upstream app, engine/WASM, repository, journal or arbitrary file paths
- Exposes no player hint, analysis, evaluation, undo, configuration or reset endpoint
- Uses independent unpredictable player/observer capabilities and denies cross-role requests
- Restricts Host and Origin, disables caching/framing, and makes no external network/model/API calls

It does not change OS security, firewall, browser permissions or Agent Core. The original static app is still available if deliberately served separately; keep that analysis application outside the player's allowed browsing surface during a match.

## Verification and scope

Run `npm test` (or `node --test`) for deterministic lifecycle/rules/import/replay checks, HTTP role/endpoint checks, and an actual bundled Stockfish Node/WASM smoke. These tests use temporary directories and never use your live journal. The real-engine check must pass rather than be replaced with a stub. The suite also checks portable-launch command construction with a fake process runner, and player/observer state logic with a minimal DOM harness. These do not count as actual Windows execution, rendering or browser interaction; those must be checked separately. Cloud Linux success does not claim Windows runtime/browser success.

The implementation intentionally uses native Node HTTP/fs/process APIs and the existing vendored chess.js and Stockfish. Observer polling currently returns the entire log: suitable for local diagnostic sessions, not indefinite/high-volume collection. Archive a closed session to a separate directory when it becomes large. The unchanged upstream dependencies remain in package.json for upstream tooling, but the arena runtime requires no npm install.

## License

The upstream root GPL-3.0 license and vendored notices are preserved. New arena code is provided under the same GPL-3.0 license. Stockfish's source/license links are recorded in the upstream README and vendor banner. The chess.js vendored license/source information remains intact. This modification is a separate arena entry, not a replacement for the original project.
