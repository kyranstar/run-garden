import type { ProgramWatchStep } from "@rg/domain";

const BOTH = " (L+R)";

/**
 * Steps as the builder laid a two-sided move out before 2026-11-05, for a copy still on the watch: a left then a right
 * step, each with its side's share of a hold and the rest on the right.
 */
export function asSentAsPairs(steps: readonly ProgramWatchStep[]): ProgramWatchStep[] {
  return steps.flatMap((s) => {
    if (!s.name.endsWith(BOTH)) return [s];
    const name = s.name.slice(0, -BOTH.length);
    const target = s.target.kind === "hold" ? { kind: "hold" as const, seconds: Math.round(s.target.seconds / 2) } : s.target;
    return [
      { ...s, name: `${name} (L)`, target, side: "left" as const, restSeconds: 0, overview: "left side" },
      { ...s, name: `${name} (R)`, target, side: "right" as const, overview: "right side" },
    ];
  });
}
