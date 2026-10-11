# Quiet Chess Memory Observation Arena: Windows handoff

Use this instruction in the existing Windows installation conversation with Remote Desktop Commander. If a new ChatGPT session is needed, create it inside project **joe** and select **Extra High** effort before submitting. The cloud build does not establish that installation or browser tests passed on Windows.

## Ready-to-copy instruction

Use **@remote desktop commander** to install and verify my modified Quiet Chess arena on my Windows computer. Work only on this arena. Do not edit, restart, upgrade, or clean Agent Core or its production Memory.

Repository: https://github.com/rendevouz999/stockfish
Branch: `arena/memory-observation`
Suggested independent location: `E:\Projects\Quiet-Chess-Arena`.

1. Identify the connected Windows device using the connector's device inventory. If multiple devices are online, ask which one. Confirm the selected device, installed Node and Git versions, free space, and target directory. Do not infer that a device is connected merely because pairing was attempted.
2. Read the repository's current README and arena documentation. Inspect an existing target directory before taking action. Do not overwrite files, reset a dirty checkout, delete logs, or replace an existing installation. If the folder does not exist, clone the exact branch to the suggested independent location. Record the checked-out commit and compare it with the delivery commit supplied by the user.
3. Use an existing compatible Node installation. Do not install or update Node, npm, Git, browsers, global packages, services, firewall rules, or credentials without reporting the specific missing prerequisite and obtaining any required permission. This arena uses vendored runtime assets; do not run an unnecessary `npm install`.
4. Run the tests documented in the current arena README. Preserve command output, timestamps, and exit codes in an ignored local report directory. Distinguish deterministic tests, real Stockfish smoke tests, browser checks, and Windows-only checks.
5. The owner uses **Brave**. Prefer the provided `start-arena-brave.cmd`, which starts the server and opens the player/observer tabs in the existing portable Brave. The manual alternative is `npm run arena` followed by opening the printed links. Bind only to localhost. Keep the server process/session available and record its identity. If the configured port is occupied, identify its owner; do not kill an unrelated process. Select another supported local port if necessary. The journal also admits one writer only. If an existing journal lock blocks startup, follow the arena README stale-lock procedure: first prove no server is using that data directory and inspect the exact lock. Never automatically delete or replace a lock whose ownership is unknown.
6. The server prints separate player and observer capability links. Open the player board and observer interface in Brave for the owner. Do not change the default browser, enable remote debugging, install extensions, or assume the exact active Brave profile/window is selected. The owner supplied an existing portable layout: the selected folder contains App/brave.exe, UserData, Cache, CrashDumps and related profile folders. The owner confirmed the existing launcher at F:/Brave-Isolated/Start-Brave-Isolated.bat, so the expected root is F:/Brave-Isolated. Verify App/brave.exe exists there before use. Double-click start-arena-brave.cmd: it uses that confirmed root only if App/brave.exe exists, otherwise it prompts for a root. The batch launcher does not accept raw path arguments; for a scripted override, the CLI equivalent is --open --browser brave --brave-root "<verified portable root>". Reuse the existing UserData; do not migrate, reset, copy or delete the profile. No new installation of Brave is needed. Do not put tokens into reports, screenshots intended for publication, Git commits, or chat transcripts. The player receives only the player capability; the observer capability is operator-only.
7. Verify actual play: start a game from the observer, click a legal move on the player board, observe a genuine Stockfish response, and confirm the timeline records accepted moves with UTC timestamps, sequence numbers, positions, and decision-window duration. Refresh both pages and verify they reconnect without manually re-entering capability links. Verify the observer Open Player action, popup-blocked fallback, and restarting a game without restarting the server. Check promotion using a dedicated test position, illegal/stale/duplicate submissions through the documented test workflow, and game lifecycle behavior. Never count a fabricated or substituted bot move as an Agent Core decision.
8. Export JSON, JSONL, and PGN through the observer and verify they correspond to the played game. Keep real gameplay/Memory data local and out of the public repository. Missing Memory events must remain explicitly unknown or absent, never filled with simulated success.
9. The arena accepts external Agent Core telemetry; that does **not** mean a live Agent Core bridge already exists. Inspect the documented schema. If live integration needs changes to Agent Core, report the precise proposed changes and wait for a separate instruction. Do not silently modify production Memory. Imported events retain their provenance labels and cannot self-assert verified status.
10. Return the actual repository path and commit, Node version, startup/stop procedure, tests passed/failed/not run, locations of local exports, and unresolved limitations. Do not claim learning, improvement, or anti-cheating containment merely because installation or five games succeeded.

The user wants a visible chain of experience → provisional lesson → revision → reuse → improved anticipation. Five games are a diagnostic checkpoint: examine actual recording, retrieval, update, and decision evidence before deciding what mechanism needs repair.

## Optional RDC connection command (user-run)

This affects npm's cache only; it does not relocate RDC's authentication/configuration files. Run only one connection attempt at a time. Complete account login and device-code matching yourself.

```cmd
npx --cache="E:/Projects/Agent-Core/.rdc-standalone/npm-cache" --yes @wonderwhy-er/desktop-commander@latest remote
```

If a verified existing standalone installation is present, the user can run it directly without npx:

```cmd
node "E:/Projects/Agent-Core/.rdc-standalone/app/node_modules/@wonderwhy-er/desktop-commander/dist/index.js" remote
```

Verify the installed package version and actual entry point first; do not assume an old install log proves the files still exist. The 0.2.52 official package maps its executable to `dist/index.js`. Do not start another instance if one is already connected.

If npm reports `ECOMPROMISED`, preserve the exact command and the new log it names. Do not delete caches or lock files, terminate unrelated Node processes, or upgrade npm based only on this error. An old installation log is not evidence of the current failure.

Official RDC setup: https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md

## Trust boundary

The observer and player are separate application roles. This is **not** an OS sandbox. An agent with arbitrary filesystem, shell, network, or unrestricted browser control on the host can bypass application-level restrictions. A scored match requires a separately restricted controller invocation; RDC installation/admin access is not the allowed tool set for that player.
