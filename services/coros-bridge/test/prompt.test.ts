/**
 * Piped-stdin behaviour of the spike prompter. The failure this pins: readline
 * drains a whole piped chunk at once, so asking one question at a time
 * discarded the remaining lines and then hung forever on the next question —
 * which surfaced as a silent exit 0.
 */

import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPrompter, InputExhaustedError } from "../src/prompt.js";

function sink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    }),
    text: () => chunks.join(""),
  };
}

function piped(text: string): NodeJS.ReadableStream & { isTTY?: boolean } {
  return Readable.from([text]) as NodeJS.ReadableStream & { isTTY?: boolean };
}

describe("createPrompter — piped stdin", () => {
  it("answers every question from one buffered chunk, in order", async () => {
    const out = sink();
    const prompter = createPrompter({ input: piped("a@b.c\nsecret\nus\nNOPE\n"), output: out.stream });

    expect(await prompter.ask("COROS email: ")).toBe("a@b.c");
    expect(await prompter.askHidden("COROS password: ")).toBe("secret");
    expect(await prompter.ask("Region: ")).toBe("us");
    expect(await prompter.ask("Confirm: ")).toBe("NOPE");
    prompter.close();

    // Prompts are still shown so a piped run is readable in logs.
    expect(out.text()).toContain("COROS email: ");
    expect(out.text()).toContain("Confirm: ");
  });

  it("rejects when input runs out instead of hanging or exiting silently", async () => {
    const prompter = createPrompter({ input: piped("only-one-line\n"), output: sink().stream });

    expect(await prompter.ask("first: ")).toBe("only-one-line");
    await expect(prompter.ask("second: ")).rejects.toBeInstanceOf(InputExhaustedError);
    await expect(prompter.ask("third: ")).rejects.toThrow(/stdin ended before answering: third:/);
    prompter.close();
  });

  it("rejects a question that was already waiting when input ended", async () => {
    const prompter = createPrompter({ input: piped(""), output: sink().stream });
    await expect(prompter.ask("nothing will answer this: ")).rejects.toBeInstanceOf(
      InputExhaustedError,
    );
    prompter.close();
  });
});
