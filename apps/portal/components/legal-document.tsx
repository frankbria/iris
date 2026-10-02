import Link from "next/link"
import type { ReactNode } from "react"

import type { LegalContent } from "@/lib/legal"

/**
 * Inline `**bold**` and `[text](href)`. React escapes every string, so the text cannot
 * inject markup; a link is kept only when it is a site path or https URL.
 */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/).map((part, i) => {
    const bold = /^\*\*([^*]+)\*\*$/.exec(part)
    if (bold) return <strong key={i}>{bold[1]}</strong>
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link) {
      const [, label, href] = link
      if (href.startsWith("/") && !href.startsWith("//"))
        return (
          <Link key={i} href={href} className="underline">
            {label}
          </Link>
        )
      if (href.startsWith("https://"))
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

/** Headings (`##`), `-` lists and paragraphs: all the legal files use. */
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
    </main>
  )
}
