# Start instructions for Codex

1. Work in `/workspace/Last-sign`.
2. Run `bash scripts/codex-install.sh`. It requires Node.js 24 and installs exactly from `package-lock.json`; npm's cache is stored under `/tmp/akher-tawqee-npm-cache` so installation does not depend on a per-user cache directory.
3. Start the client and authoritative Socket.IO server with `npm run dev`. Keep this process alive in the persistent terminal. Vite binds to `0.0.0.0:5173`; the server binds to `0.0.0.0:4000`; Vite proxies `/socket.io` to the server.
4. Wait for both startup lines, then check `curl --fail http://127.0.0.1:4000/health`. A ready response is HTTP 200 JSON: `{"status":"ok","service":"akher-tawqee-server","protocolVersion":1}`. Open port 5173 in the browser; the browser connects through the same-origin Vite proxy.
5. For production, run `npm run build`, then `npm start`. The long-lived Node server serves the built frontend, `/join/:roomCode`, `/health`, and Socket.IO from port 4000. A public deployment needs HTTPS and a reverse proxy that forwards WebSocket upgrades.
6. If a port is busy, set `PORT` for production or update the Vite proxy target for development. Inspect the persistent terminal for startup errors. A successful health check verifies the server only; use the browser and real-client tests to verify a room and round.

Room state and reconnect credentials use in-memory storage; a process restart ends active games. The current alpha supports six-round free-for-all matches; cards 1, 3–6, 8, 10–16, 18, 21–23, 25, 26, 31, 32, 35, 37, 40, 43, 47, 48, 54, and 56 have playable effects. Other cards and team mode remain unavailable. Setup, build, health, real-client 3/12-seat matches, and the browser room test have been verified locally.
