# AKHER TAWQEE implementation plan

## Milestones

1. **Foundation:** TypeScript npm workspace, React/Vite client, long-lived Node/Socket.IO server, shared game package, health endpoint, reproducible install/build/test/start commands.
   - Complete when `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` pass from a clean checkout, and `/health` responds from the started server.
2. **Rooms:** create/join by code and `/join/:roomCode`, host/settings/ready controls, 12 seats, hashed reconnect credentials, private/public snapshots, idempotent acknowledgments, expiry.
   - Complete when real Socket.IO clients cover create, join, host authorization, capacity, reconnect, expiry, and snapshot privacy.
3. **Free-for-all rounds:** deterministic engine, resources/cards/lots, secret declarations/wagers/final actions, phase deadlines, auction, settlement, scoring, round/game end.
   - Complete when complete 3- and 12-player simulations and phase/resource/tie cases pass through the real server.
4. **Wagers/contracts/audit:** predicate-based private wagers, bilateral escrowed contracts, event proofs, complete round summaries.
   - Complete when settlement and privacy tests cover success, failure, void, breach, and replay.
5. **Card system:** all 60 exact card records, Arabic text, target/parameter forms, timing windows, effect handlers, counters, decisions, art directions, and card matrix.
   - Complete when every card has a resolver/no-op reason, UI path, and trigger/no-op/boundary coverage.
6. **Team mode:** valid equal teams, shared resources/score, atomic quota allocation and spending, team results.
   - Complete when all supported team counts and concurrent budget invariants pass.
7. **Release readiness:** complete Arabic RTL screens, keyboard/mobile accessibility, browser tests, CI, deployment/container documentation, final requirement matrix.
   - Complete when browser sessions exercise the real server, CI commands pass, and deployment requirements are documented.

## Dependencies and constraints

- Node.js 24 LTS and npm workspaces; `package-lock.json` is the source of dependency reproducibility.
- React + Vite; Express + Socket.IO; a shared pure TypeScript game engine; in-memory room storage behind an interface for the alpha.
- No account, payment, AI gameplay, personality inference, or static-only deployment.
- Network dependencies use the environment's existing npm/GitHub egress preset. No secret is required for local development.
- Existing selected repository was empty and the configured GitHub remote advertised no refs at inspection time; work is being created in the existing checkout without resetting it.

## Product decisions to resolve

See [`docs/rules-decisions.md`](docs/rules-decisions.md). Foundation, room transport, and isolated engine work can proceed while those decisions are pending; affected game rules must not be silently fixed by implementation.
