const HOME = "/dashboard"
const BASE = "http://portal.invalid"

/**
 * The `?next=` path to go to after logging in, if it stays on this site; the dashboard
 * otherwise. It is parsed the way the browser will parse it, because the browser drops
 * tabs and newlines and reads `\` as `/`: `/\t/evil.example` becomes `//evil.example`.
 * The parsed path is checked again, because dot-segments collapse into a
 * protocol-relative one: `/.//evil.example` has the path `//evil.example`.
 */
export function safeNext(next: unknown): string {
  // A repeated ?next= arrives as an array.
  if (typeof next !== "string" || !next.startsWith("/")) return HOME
  if (!URL.canParse(next, BASE)) return HOME
  const url = new URL(next, BASE)
  if (url.origin !== BASE || url.pathname.startsWith("//")) return HOME
  return url.pathname + url.search + url.hash
}
