import { ResetPasswordForm } from "@/components/auth-forms"

/** BetterAuth redirects here with `?token=` from the mailed link, or `?error=INVALID_TOKEN`. */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams
  return <ResetPasswordForm token={token ?? null} />
}
