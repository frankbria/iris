import { LogInForm } from "@/components/auth-forms"
import { safeNext } from "@/lib/safe-next"

const NOTICES: Record<string, string> = {
  reset: "Password changed. Log in with the new one.",
  verified: "Email verified. Log in to continue.",
}

export default async function LogInPage({
  searchParams,
}: {
  searchParams: Promise<{
    reset?: string
    verified?: string
    error?: string
    next?: string
  }>
}) {
  const params = await searchParams
  const next = safeNext(params.next)
  // A failed verification comes back to the sign-up callbackURL with `&error=`
  // appended, next to its `verified=1`. The error wins. Logging in mails a fresh link.
  if (params.error)
    return (
      <LogInForm
        next={next}
        notice="That link has expired or was already used. Log in and we will send you a new one."
      />
    )
  const key = Object.keys(NOTICES).find(
    (k) => params[k as keyof typeof params] === "1"
  )
  return <LogInForm next={next} notice={key ? NOTICES[key] : null} />
}
