import type { Metadata } from "next"

import { LegalDocument } from "@/components/legal-document"
import { readLegal } from "@/lib/legal"

export const metadata: Metadata = { title: "Acceptable Use Policy" }

export default function AcceptableUsePage() {
  return <LegalDocument doc={readLegal("acceptable-use")} />
}
