# Implementation status

Updated: 2026-10-21

## Verified baseline

- The project was published to `ShireefTarek/Last-sign` on `main` at commit `a80ff60`. This visual update is in progress on the existing local `work` branch and has not yet been pushed.
- Runtime: Node.js `v24.19.0`, npm `11.9.0`.
- The attached product specification is represented in `packages/game-engine/src/cards.ts`; it contains 60 unique card records and the supplied effect/counterplay/art-direction text.
- User decisions recorded in `docs/rules-decisions.md`: final lot changes are free, crowding counts real players with ties eligible as both extrema, and scandal is checked at round end.

## Milestones

| Area | Status | Evidence and remaining work |
| --- | --- | --- |
| Foundation | **Complete for local development** | Clean `bash scripts/codex-install.sh`, root typecheck, build, and production `/health` check passed. npm workspace, React/Vite, Socket.IO server, Dockerfile, CI, lockfile, and start instructions exist. |
| Rooms | **Core flow implemented** | Real server tests cover create/join, duplicate names, host-only settings, 12-seat cap, invalid credentials, reconnect, and private hand restoration. Browser test covers invite-link join and ready on a 390px viewport. Room expiry and stale/idempotent replay cases need more coverage. |
| Free-for-all | **Six-round match flow verified** | Real Socket.IO simulations complete six rounds with 3 and 12 independent clients; a separate three-client scenario awards and audits a seal. |
| Wagers and audit | **Partial** | Predefined predicates, paid optional second wager, void refund, settlement scoring, and summary evidence are present. Formal contracts and proof event IDs remain unimplemented. |
| Card register | **29 of 60 effects playable** | Cards 1, 3–6, 8, 10–16, 18, 21–23, 25, 26, 31, 32, 35, 37, 40, 43, 47, 48, 54, and 56 have server-owned resolvers and Arabic player copy. Hidden-announcement privacy, declaration revisions, crowd pressure, direct targeting, card costs, bid-band contradiction, influence invoices, scandal changes/reductions, settlement records, and refunds are tested. Contracts, other interactive decisions, other effects, and comprehensive per-card coverage remain outstanding. |
| Table scene | **3D playable slice implemented** | Lobby and match show a shared oval table, chairs, papers, lots, and generated seated player models with distinct wardrobe/accessory sets and twelve role labels with varied idle mannerisms. Camera drag/zoom, player/document/card gaze, and synchronized wave/point/thinking/shrug/nod actions are implemented. The client bundle is split so Three.js loads with the scene rather than the landing screen. Production character art and richer per-character animation remain outstanding. |
| Story | **Opening and round interludes implemented** | A skippable three-beat cinematic introduces the inheritance dispute. Each subsequent round has a short chapter interlude over the moving 3D table. Voice acting, branching dialogue, and character-specific story scenes are not implemented yet. |
| Team mode | **Not implemented** | Team-size validation exists; the server and UI explicitly keep team mode unavailable. Shared influence, quotas, and team scoring remain outstanding. |
| Release readiness | **Partial** | Arabic RTL responsive interface, CI, and Docker build instructions exist. Pause/resume, final-room controls, all acceptance paths, polished character assets, and live deployment are not verified. |

## Checks run after clean install

| Command/check | Result |
| --- | --- |
| `bash scripts/codex-install.sh` | Passed; `npm ci` installed from the lockfile using the `/tmp` cache. |
| `npm run typecheck` | Passed for engine, server, and web. |
| `npm run typecheck` after 3D scene, synchronized character actions, and round interludes | Passed for engine, server, and web. |
| `npm test` | Passed: 30 tests across engine and real Socket.IO server tests, including complete 3- and 12-seat, six-round simulations. |
| `npm run build` | Passed for engine, server, and web. |
| `npm run build` after 3D scene and round-interlude implementation | Passed for engine, server, and web. Vite reports the isolated Three.js chunk at 526 kB minified (132 kB gzip). |
| `npm run dev` plus local requests to `/` and `/health` | Passed: Vite served the Arabic app shell, and the multiplayer server returned HTTP 200 with its healthy status payload. Both dev processes were stopped after the check. |
| `npm run test:e2e` | Passed: real browser, two independent contexts, invite-link room join and ready on a mobile viewport. |
| Production `/health` | Passed: HTTP 200 with `{ "status": "ok", "service": "akher-tawqee-server", "protocolVersion": 1 }`. |

## Resume point

Continue the visual direction with detailed character art, character selection, voice, branching dialogue, and richer hand/document reactions. Keep player poses cosmetic and server-relayed; they must never affect scoring or reveal private cards. Then continue card coverage and team-mode implementation.
