const HOME = "/dashboard"
const BASE = "http://portal.invalid"

/**
 * The `?next=` path to go to after logging in, if it stays on this site; the dashboard
 * otherwise. It is parsed the way the browser will parse it, because the browser drops
 * tabs and newlines and reads `\` as `/`: `/\t/evil.example` becomes `//evil.example`.
 */
export function safeNext(next: string | undefined): string {
  if (!next?.startsWith("/")) return HOME
  const url = new URL(next, BASE)
  return url.origin === BASE ? url.pathname + url.search + url.hash : HOME
}
