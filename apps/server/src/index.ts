import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGameServer } from "./server.js";

export { createGameServer } from "./server.js";
export { MemoryRoomStore } from "./room-store.js";

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const server = createGameServer();
  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT ?? 4000);
  await server.listen(port, host);
  console.log(`AKHER TAWQEE server listening on ${host}:${port}`);
}
