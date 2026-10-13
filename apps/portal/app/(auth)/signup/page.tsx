import { SignUpForm } from "@/components/auth-forms"
import { safeNext } from "@/lib/safe-next"

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>
}) {
  // Kept through verification (#409): an invitee lands back on the invitation.
  const { next } = await searchParams
  return <SignUpForm next={next === undefined ? undefined : safeNext(next)} />
}
