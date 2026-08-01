/**
 * COROS bridge entrypoint: a Tauri sidecar speaking newline-delimited JSON
 * over stdin/stdout. It never opens an HTTP port.
 *
 *  - stdout carries protocol JSON ONLY.
 *  - stderr carries sanitized logs (operation + result codes; never bodies,
 *    tokens, or credentials).
 *  - Requests are processed strictly sequentially so COROS writes serialize.
 */

import { createInterface } from "node:readline";
import { createBridgeState, handleLine } from "./protocol.js";

const state = createBridgeState();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

let queue: Promise<void> = Promise.resolve();

rl.on("line", (line) => {
  if (line.trim() === "") return;
  queue = queue
    .then(async () => {
      const response = await handleLine(state, line);
      process.stdout.write(`${JSON.stringify(response)}\n`);
      if (state.shuttingDown) {
        rl.close();
        // Let the response flush before exiting.
        setImmediate(() => process.exit(0));
      }
    })
    .catch((e: unknown) => {
      console.error(
        `[coros-bridge] handler failure: ${e instanceof Error ? e.name : "unknown"}`,
      );
    });
});

rl.on("close", () => {
  console.error("[coros-bridge] stdin closed");
});

console.error("[coros-bridge] ready (ndjson over stdio)");
