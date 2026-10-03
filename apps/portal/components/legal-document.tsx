import Link from "next/link"
import type { ReactNode } from "react"

import type { LegalContent } from "@/lib/legal"

const SITE = "https://portal.invalid"

/**
 * `href` if it is a link on this site or an https URL, else null. Browsers read `\` as
 * `/` and drop tab/newline, so `/\evil.com` would leave the site: any backslash, space
 * or control character is refused before the URL is resolved.
 */
function safeHref(href: string): string | null {
  if (/[\\\s\x00-\x1f\x7f]/.test(href)) return null
  let url: URL
  try {
    url = new URL(href, SITE)
  } catch {
    return null
  }
  if (url.origin === SITE) return href.startsWith("/") ? href : null
  return url.protocol === "https:" && /^https:\/\//i.test(href) ? href : null
}

/**
 * Inline `**bold**` and `[text](href)`. React escapes every string, so the text cannot
 * inject markup; a link is kept only when {@link safeHref} accepts it.
 */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/).map((part, i) => {
    const bold = /^\*\*([^*]+)\*\*$/.exec(part)
    if (bold) return <strong key={i}>{bold[1]}</strong>
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link) {
      const [, label, raw] = link
      const href = safeHref(raw)
      if (href?.startsWith("/"))
        return (
          <Link key={i} href={href} className="underline">
            {label}
          </Link>
        )
      if (href)
        return (
          <a key={i} href={href} className="underline">
            {label}
          </a>
        )
      return label
    }
    return part
  })
}

/** `| a | b |` -> ["a", "b"]. Cells may not contain `|`. */
const cells = (line: string) =>
  line
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim())

/**
 * A pipe table: a header row, a `|---|` separator, then body rows, every line starting
 * and ending with `|`. Cells go through `inline()`, so they are escaped like any text.
 */
function table(lines: string[], key: number): ReactNode | null {
  if (
    lines.length < 2 ||
    !lines.every((l) => l.startsWith("|") && l.endsWith("|")) ||
    !/^\|(\s*:?-+:?\s*\|)+$/.test(lines[1])
  )
    return null
  return (
    <div key={key} className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            {cells(lines[0]).map((c, j) => (
              <th key={j} className="border-b px-2 py-1 font-medium">
                {inline(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.slice(2).map((row, r) => (
            <tr key={r}>
              {cells(row).map((c, j) => (
                <td key={j} className="border-b px-2 py-1 align-top">
                  {inline(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Headings (`##`), `-` lists, pipe tables and paragraphs: all the legal files use. */
function blocks(markdown: string): ReactNode[] {
  return markdown.split(/\n{2,}/).map((chunk, i) => {
    const heading = /^## (.+)$/.exec(chunk)
    if (heading)
      return (
        <h2 key={i} className="mt-6 font-heading text-base font-medium">
          {inline(heading[1])}
        </h2>
      )
    const lines = chunk.split("\n")
    const tabular = table(lines, i)
    if (tabular) return tabular
    if (lines.every((l) => l.startsWith("- ")))
      return (
        <ul key={i} className="list-disc space-y-1 pl-5">
          {lines.map((l, j) => (
            <li key={j}>{inline(l.slice(2))}</li>
          ))}
        </ul>
      )
    return <p key={i}>{inline(lines.join(" "))}</p>
  })
}

export function LegalDocument({ doc }: { doc: LegalContent }) {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col gap-3 p-6 text-sm leading-relaxed">
      {doc.draft && (
        <p
          role="note"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-medium text-destructive"
        >
          Draft — pending review; not yet in effect
        </p>
      )}
      <h1 className="font-heading text-lg font-medium">{doc.title}</h1>
      <p className="text-muted-foreground">Version {doc.version}</p>
      {blocks(doc.body)}
      <p className="mt-6">
        <Link href="/" className="underline">
          Back to the portal
        </Link>
      </p>
      <LegalFooter />
    </main>
  )
}

/** Every public legal document, and the contacts (#348), linked from the legal and sign-in pages (#277). */
export const LEGAL_LINKS = [
  ["/terms", "Terms"],
  ["/acceptable-use", "Acceptable Use"],
  ["/privacy", "Privacy"],
  ["/subprocessors", "Subprocessors"],
  ["/dpa", "DPA"],
  ["/contact", "Contact"],
] as const

export function LegalFooter() {
  return (
    <footer className="border-t px-6 py-4 text-xs text-muted-foreground">
      <nav
        aria-label="Legal"
        className="flex flex-wrap justify-center gap-x-4 gap-y-1"
      >
        {LEGAL_LINKS.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className="underline-offset-4 hover:underline"
          >
            {label}
          </Link>
        ))}
      </nav>
    </footer>
  )
}
