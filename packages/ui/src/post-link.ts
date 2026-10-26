/**
 * A saved post's address as a link (saved-posts import): a web page's only — never `javascript:` or the like; null
 * otherwise. Shared by every place the app draws one (the Studio's move detail and review screen, Settings → Saves).
 */
export function postHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}
