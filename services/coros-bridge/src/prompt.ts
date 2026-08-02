/**
 * Interactive prompting for the write spikes, with no-echo password entry.
 *
 * readline echoes what it reads back to its `output` stream, so the password
 * is hidden by routing that stream through a Writable that can be muted for
 * the duration of one question. No dependencies, no raw-mode bookkeeping.
 */

import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";

class MutableOutput extends Writable {
  muted = false;

  constructor(private readonly target: NodeJS.WritableStream) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) this.target.write(chunk);
    callback();
  }

  /** Write past the mute — for the newline the hidden Enter never echoed. */
  writeDirect(text: string): void {
    this.target.write(text);
  }
}

export interface Prompter {
  /** The underlying interface, for SIGINT wiring and close(). */
  readonly rl: Interface;
  ask(question: string): Promise<string>;
  /** Reads a line without echoing it. */
  askHidden(question: string): Promise<string>;
  close(): void;
}

export function createPrompter(): Prompter {
  const output = new MutableOutput(process.stdout);
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: process.stdin.isTTY === true,
  });
  return {
    rl,
    ask: (question) => rl.question(question),
    askHidden: async (question) => {
      // question() writes the prompt synchronously, so muting straight after
      // hides the typed characters but not the prompt itself.
      const pending = rl.question(question);
      output.muted = true;
      try {
        return await pending;
      } finally {
        output.muted = false;
        output.writeDirect("\n"); // the Enter keystroke never echoed
      }
    },
    close: () => rl.close(),
  };
}
