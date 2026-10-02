import { readFileSync } from "node:fs"
import path from "node:path"

import type { LegalDocument } from "../../../src/legal/versions"

/** A legal document from `content/legal/` (#276). Trusted repo files, never user input. */
export type LegalContent = {
  title: string
  version: string
  /** True while the owner has not approved the text; the page then says so. */
  draft: boolean
  body: string
}

/** Front matter is flat `key: value` lines between two `---` lines. */
export function parseLegal(source: string): LegalContent {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
  if (!match) throw new Error("legal document has no front matter")
  const meta = Object.fromEntries(
    match[1].split("\n").map((line) => {
      const i = line.indexOf(":")
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
    })
  )
  if (!meta.title || !meta.version)
    throw new Error("legal front matter needs title and version")
  return {
    title: meta.title,
    version: meta.version,
    draft: meta.draft === "true",
    body: match[2].trim(),
  }
}

export function readLegal(name: LegalDocument): LegalContent {
  return parseLegal(
    readFileSync(
      path.join(process.cwd(), "content", "legal", `${name}.md`),
      "utf8"
    )
  )
}
