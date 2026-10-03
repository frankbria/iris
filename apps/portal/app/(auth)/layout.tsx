import { LegalFooter } from "@/components/legal-document"

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-svh flex-col">
      <main className="flex flex-1 items-center justify-center p-6">
        {children}
      </main>
      <LegalFooter />
    </div>
  )
}
