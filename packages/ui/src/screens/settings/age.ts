/** "today", "1 day ago", "9 days ago": whole days since `iso`, as Settings' rows say it. */
export function ageText(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
  if (!(days > 0)) return "today";
  return days === 1 ? "1 day ago" : `${days.toLocaleString()} days ago`;
}
