import type { Metadata } from "next"

import { LegalDocument } from "@/components/legal-document"
import { readLegal } from "@/lib/legal"

export const metadata: Metadata = { title: "Subprocessors" }

export default function SubprocessorsPage() {
  return <LegalDocument doc={readLegal("subprocessors")} />
}
