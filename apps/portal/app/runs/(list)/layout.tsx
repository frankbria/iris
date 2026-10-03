import { requireOrg } from "@/lib/org"

/**
 * The list streams behind `loading.tsx`, and a redirect from inside a stream arrives
 * as a 200 with a meta refresh. The gate runs here, above that boundary, so signed-out
 * or terms-pending users get a real redirect; the page reuses the cached answer.
 */
export default async function RunsListLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await requireOrg()
  return children
}
