# Implementation status

Updated: 2026-10-21

## Verified baseline

- The existing checkout is `/workspace/Last-sign`, branch `work`, with no commit at the time implementation began. The configured GitHub repository had no advertised refs during inspection. Changes remain local and have not been pushed.
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
| Team mode | **Not implemented** | Team-size validation exists; the server and UI explicitly keep team mode unavailable. Shared influence, quotas, and team scoring remain outstanding. |
| Release readiness | **Partial** | Arabic RTL responsive interface, local browser test, CI, and Docker build instructions exist. Pause/resume, final-room controls, all acceptance paths, and live deployment are not verified. |

## Checks run after clean install

| Command/check | Result |
| --- | --- |
| `bash scripts/codex-install.sh` | Passed; `npm ci` installed from the lockfile using the `/tmp` cache. |
| `npm run typecheck` | Passed for engine, server, and web. |
| `npm test` | Passed: 30 tests across engine and real Socket.IO server tests, including complete 3- and 12-seat, six-round simulations. |
| `npm run build` | Passed for engine, server, and web. |
| `npm run test:e2e` | Passed: real browser, two independent contexts, invite-link room join and ready on a mobile viewport. |
| Production `/health` | Passed: HTTP 200 with `{ "status": "ok", "service": "akher-tawqee-server", "protocolVersion": 1 }`. |

## Resume point

Implement card parameter/localization schemas and deterministic card resolution first; add interactive target choices as bounded server states. Then complete team shared-budget allocation and full-match/property tests. Keep unavailable modes visibly disabled until those paths work.
