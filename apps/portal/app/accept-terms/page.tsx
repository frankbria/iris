import { headers } from "next/headers"
import Link from "next/link"
import { redirect } from "next/navigation"

import { hasAcceptedCurrent } from "../../../../src/legal/acceptance"
import { ACCEPTED_TERMS } from "../../../../src/legal/versions"
import { acceptTerms } from "./actions"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getAuth, getDb } from "@/lib/auth"

/** Where a signed-in user who has not accepted the current terms lands (#276). */
export default async function AcceptTermsPage() {
  const requestHeaders = await headers()
  const session = await getAuth().api.getSession({ headers: requestHeaders })
  if (!session) redirect("/login")
  if (await hasAcceptedCurrent(getDb(), session.user.id)) redirect("/dashboard")
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Review our terms</CardTitle>
          <CardDescription>
            The Terms of Service or Acceptable Use Policy changed. Accept the
            new versions to keep using the portal. API keys keep working.
          </CardDescription>
        </CardHeader>
        <form action={acceptTerms}>
          <input type="hidden" name="acceptedTerms" value={ACCEPTED_TERMS} />
          <CardContent>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="agree" required className="mt-1" />
              <span>
                I agree to the{" "}
                <Link href="/terms" target="_blank" className="underline">
                  Terms of Service
                </Link>{" "}
                and{" "}
                <Link
                  href="/acceptable-use"
                  target="_blank"
                  className="underline"
                >
                  Acceptable Use Policy
                </Link>
              </span>
            </label>
          </CardContent>
          <CardFooter className="mt-4">
            <Button type="submit" className="w-full">
              Accept and continue
            </Button>
          </CardFooter>
        </form>
      </Card>
    </main>
  )
}
