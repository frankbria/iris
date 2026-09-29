import { LogInForm } from "@/components/auth-forms"

export default async function LogInPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string }>
}) {
  const { reset } = await searchParams
  return <LogInForm passwordReset={reset === "1"} />
}
