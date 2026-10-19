/**
 * THE COACH'S VOICE, AS VARIABLES (the voice workshop; coach-replay.ts). A small, generic style block: how the coach's
 * words to the athlete read — their length, their tone, what they carry beyond the point, and whom they address — and
 * never what the coach decides or designs.
 *
 * DATA, NEVER FREE TEXT. Each variable is an enum (`voiceSettingsSchema`, strict): the block's every word is this module's
 * own, picked by the values, so nothing a client sends reaches the prompt as text.
 *
 * NONE SET, NO BLOCK. Today's production voice is the prompt's own (design-prompt.ts, the main block's last words:
 * brisk, one next step the card doesn't show, no apologies — the owner's pick from these replays, 2026-10-19): a
 * variant with no variable set adds nothing (`voiceBlock` answers null), and its request is the production
 * request byte for byte (pinned in coach-replay.test.ts). `plain` set explicitly is a variable like any other: it adds
 * its line.
 *
 * Generic by rule (principles §0, §8): nothing here describes the athlete.
 */
import { z } from "zod";

export const VOICE_LENGTHS = ["sentence", "few", "paragraph"] as const;
export const VOICE_TONES = ["plain", "warm", "brisk"] as const;
export const VOICE_INCLUDES = ["why", "numbers", "next_step", "none"] as const;
export const VOICE_PERSONS = ["you", "neutral"] as const;

export type VoiceLength = (typeof VOICE_LENGTHS)[number];
export type VoiceTone = (typeof VOICE_TONES)[number];
export type VoiceInclude = (typeof VOICE_INCLUDES)[number];
export type VoicePerson = (typeof VOICE_PERSONS)[number];

export interface VoiceSettings {
  length?: VoiceLength;
  tone?: VoiceTone;
  include?: VoiceInclude;
  person?: VoicePerson;
}

export const voiceSettingsSchema = z
  .object({
    length: z.enum(VOICE_LENGTHS).optional(),
    tone: z.enum(VOICE_TONES).optional(),
    include: z.enum(VOICE_INCLUDES).optional(),
    person: z.enum(VOICE_PERSONS).optional(),
  })
  .strict();

/** The block's first line: what it governs, and what it never changes. */
export const VOICE_HEAD =
  "Voice for your words to the athlete in this turn — your finish line or answer, a question you ask, a workout's title, intent, whys and cues. It changes how they read, never what you decide or design:";

export const VOICE_LINES: {
  readonly length: Readonly<Record<VoiceLength, string>>;
  readonly tone: Readonly<Record<VoiceTone, string>>;
  readonly include: Readonly<Record<VoiceInclude, string>>;
  readonly person: Readonly<Record<VoicePerson, string>>;
} = {
  length: {
    sentence: "Length: one sentence.",
    few: "Length: two or three short sentences.",
    paragraph: "Length: a short paragraph, four or five sentences at most.",
  },
  tone: {
    plain: "Tone: plain and calm. Say what it is, simply, with no cheerleading.",
    warm: "Tone: warm and encouraging, as a coach who knows them. Never gushing.",
    brisk: "Tone: brisk and direct. Lead with the point; no preamble, no softening.",
  },
  include: {
    why: "Include the one reason that matters most.",
    numbers: "Include the one or two numbers that matter most (a pace, a time, a count), and no others.",
    next_step: "Include one next step for them: what to do, or what to notice.",
    none: "Say what it is and stop: no reasons, numbers or next steps.",
  },
  person: {
    you: 'Speak to them as "you".',
    neutral: 'Write it neutrally: no "you", and no "I".',
  },
};

/** The settings a variant set, in the block's order: only the ones it named. */
export function voiceSettingsOf(v: VoiceSettings): VoiceSettings {
  return {
    ...(v.length ? { length: v.length } : {}),
    ...(v.tone ? { tone: v.tone } : {}),
    ...(v.include ? { include: v.include } : {}),
    ...(v.person ? { person: v.person } : {}),
  };
}

/** The block for `v`, one line a variable it sets; null when it sets none (today's voice: no block at all). */
export function voiceBlock(v: VoiceSettings): string | null {
  const lines = [
    v.length ? VOICE_LINES.length[v.length] : null,
    v.tone ? VOICE_LINES.tone[v.tone] : null,
    v.include ? VOICE_LINES.include[v.include] : null,
    v.person ? VOICE_LINES.person[v.person] : null,
  ].filter((l): l is string => l !== null);
  return lines.length === 0 ? null : [VOICE_HEAD, ...lines.map((l) => `- ${l}`)].join("\n");
}
