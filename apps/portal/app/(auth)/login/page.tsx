import { LogInForm } from "@/components/auth-forms"

const NOTICES: Record<string, string> = {
  reset: "Password changed. Log in with the new one.",
  verified: "Email verified. Log in to continue.",
}

export default async function LogInPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string; verified?: string }>
}) {
  const params = await searchParams
  const key = Object.keys(NOTICES).find(
    (k) => params[k as keyof typeof params] === "1"
  )
  return <LogInForm notice={key ? NOTICES[key] : null} />
}
