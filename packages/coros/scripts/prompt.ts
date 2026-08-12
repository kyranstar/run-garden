/**
 * Interactive prompting for the write spikes, with no-echo password entry and
 * correct behaviour on piped (non-TTY) stdin.
 *
 * On a TTY, readline echoes what it reads back to its `output` stream, so the
 * password is hidden by routing that stream through a Writable that can be
 * muted for the duration of one question.
 *
 * On piped stdin the whole input arrives in one chunk and readline emits every
 * `line` immediately. Answering one question at a time with `rl.question()`
 * would DISCARD the unconsumed lines and then hang forever on the next
 * question — so every line is queued instead, and questions shift from the
 * queue. Running out of input REJECTS with a clear error; it must never look
 * like a clean exit.
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

  /** Write past the mute — for prompts and the un-echoed newline. */
  writeDirect(text: string): void {
    this.target.write(text);
  }
}

export class InputExhaustedError extends Error {
  override readonly name = "InputExhaustedError";
  constructor(question: string) {
    super(`stdin ended before answering: ${question.trim()}`);
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

export interface PrompterOptions {
  /** Defaults to process.stdin. Injected by tests. */
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Defaults to process.stdout. Injected by tests. */
  output?: NodeJS.WritableStream;
}

export function createPrompter(opts: PrompterOptions = {}): Prompter {
  const input = opts.input ?? process.stdin;
  const output = new MutableOutput(opts.output ?? process.stdout);
  const isTty = input.isTTY === true;
  const rl = createInterface({ input, output, terminal: isTty });

  if (isTty) {
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

  // ── Piped stdin ───────────────────────────────────────────────────────────
  const buffered: string[] = [];
  const waiting: Array<{
    question: string;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }> = [];
  let ended = false;

  rl.on("line", (line: string) => {
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(line);
    else buffered.push(line); // keep it — the next question will want it
  });
  rl.on("close", () => {
    ended = true;
    while (waiting.length > 0) {
      const waiter = waiting.shift();
      if (waiter) waiter.reject(new InputExhaustedError(waiter.question));
    }
  });

  const ask = (question: string): Promise<string> => {
    output.writeDirect(question);
    const next = buffered.shift();
    if (next !== undefined) {
      output.writeDirect("\n");
      return Promise.resolve(next);
    }
    if (ended) return Promise.reject(new InputExhaustedError(question));
    return new Promise<string>((resolve, reject) => {
      waiting.push({ question, resolve, reject });
    });
  };

  return {
    rl,
    ask,
    askHidden: ask, // nothing is echoed on a pipe in the first place
    close: () => rl.close(),
  };
}
