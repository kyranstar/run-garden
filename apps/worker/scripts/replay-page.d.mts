/** Types for replay-page.mjs (the voice workshop's comparison page): its test imports it. */
export function escapeHtml(value: unknown): string;
export function settingsLabel(settings: Record<string, string> | undefined): string[];
export function replaysOf(data: unknown): Array<Record<string, unknown>>;
export function buildReplayPage(data: unknown, o?: { title?: string }): string;
