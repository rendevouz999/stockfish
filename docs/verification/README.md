# Verification evidence

Environment: cloud Linux, Node 24.19.0. No user computer or production Memory was used.

## Core arena checkpoint

- `npm test`: 24/24 passed (rules, lifecycle, telemetry validation, journal replay, concurrency, HTTP authorization, real bundled Stockfish, UI-state regressions, and portable Brave launch-plan tests).
- `node --check arena/public/player.js` and `node --check arena/public/observer.js`: passed.
- `git diff --check`: passed.
- Independent HTTP smoke: all 9 scenarios passed; see [http-smoke.json](http-smoke.json). This exercised the actual server and Stockfish, not a rendered browser.
- Independent review resolved the stale journal-lock race, malformed Memory version acceptance, stale/cached UI-state rollback, Windows test discovery, and even-sample median.
- Original static application files and vendored engine/assets are unchanged from upstream `6859f2fa7f8b9b2c030effce2ed496f5c4668912`.

## Explicitly unverified

- Rendered browser UI, actual board clicks, browser downloads, layout and refresh behavior. Browser launch was blocked by the cloud environment; an existing browser could not reach the local test server. No access restriction was bypassed.
- Windows startup, CMD parsing, and actual portable Brave process/profile/tab integration. Launch-plan tests mock process creation; they do not prove real Windows browser behavior.
- Live Agent Core Memory read/write bridge or authentic learning outcomes.
- Automatic chess accuracy/blunder scoring and controlled Memory-on/off outcome evaluation.
- Host-level containment of a player with broad shell, filesystem, browser or network tools.

The Windows handoff lists the remaining installation and UI acceptance steps. HTTP success does not replace visual/browser validation. Imported Memory examples are test fixtures, not evidence of actual learning.
