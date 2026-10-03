import type { Metadata } from "next"

import { LegalDocument } from "@/components/legal-document"
import { readLegal } from "@/lib/legal"

export const metadata: Metadata = { title: "Data Processing Agreement" }

export default function DpaPage() {
  return <LegalDocument doc={readLegal("dpa")} />
}
