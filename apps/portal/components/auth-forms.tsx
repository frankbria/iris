"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authClient } from "@/lib/auth-client"

type AuthError = { status: number; message?: string } | null

/** What a person should read for a failed auth call. Never says whether an account exists. */
function describe(error: NonNullable<AuthError>): string {
  if (error.status === 403)
    return "Verify your email address first. We sent the link when you signed up."
  if (error.status === 429)
    return "Too many attempts. Wait a minute and try again."
  if (error.status === 401) return "Invalid email or password."
  return error.message || "Something went wrong. Try again."
}

function Field({
  label,
  ...props
}: { label: string } & React.ComponentProps<typeof Input>) {
  const id = props.name
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} required {...props} />
    </div>
  )
}

/**
 * False in the server HTML, true once React has hydrated. Until then a submit would
 * be the browser's own GET, with the password in the URL, so the button stays disabled
 * (which also blocks submitting with Enter).
 */
const noop = () => () => {}
function useHydrated() {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false
  )
}

function AuthCard(props: {
  title: string
  description?: ReactNode
  error?: string | null
  notice?: ReactNode
  submit: string
  busy: boolean
  onSubmit: (form: FormData) => void
  footer?: ReactNode
  children?: ReactNode
}) {
  const hydrated = useHydrated()
  const handle = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    props.onSubmit(new FormData(event.currentTarget))
  }
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        {props.description && (
          <CardDescription>{props.description}</CardDescription>
        )}
      </CardHeader>
      <form onSubmit={handle}>
        <CardContent className="grid gap-4">
          {props.notice && (
            <p role="status" className="text-sm text-muted-foreground">
              {props.notice}
            </p>
          )}
          {props.children}
          {props.error && (
            <p role="alert" className="text-sm text-destructive">
              {props.error}
            </p>
          )}
        </CardContent>
        <CardFooter className="mt-4 flex flex-col gap-3">
          <Button
            type="submit"
            className="w-full"
            disabled={!hydrated || props.busy}
          >
            {props.submit}
          </Button>
          {props.footer}
        </CardFooter>
      </form>
    </Card>
  )
}

/** Runs one auth call, holding the busy flag and turning a failure into a message. */
function useAuthAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (call: () => Promise<{ error: AuthError }>) => {
    setBusy(true)
    setError(null)
    const { error } = await call()
    setBusy(false)
    if (error) setError(describe(error))
    return !error
  }
  return { busy, error, run }
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "")

export function SignUpForm() {
  const { busy, error, run } = useAuthAction()
  const [sentTo, setSentTo] = useState<string | null>(null)

  if (sentTo)
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription role="status">
            We sent a link to {sentTo}. Follow it to finish creating your
            account.
          </CardDescription>
        </CardHeader>
      </Card>
    )

  return (
    <AuthCard
      title="Create your IRIS account"
      submit="Create account"
      busy={busy}
      error={error}
      onSubmit={async (form) => {
        const email = text(form, "email")
        const ok = await run(() =>
          authClient.signUp.email({
            name: text(form, "name"),
            email,
            password: text(form, "password"),
            callbackURL: "/dashboard",
          })
        )
        if (ok) setSentTo(email)
      }}
      footer={
        <p className="text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="underline">
            Log in
          </Link>
        </p>
      }
    >
      <Field label="Name" name="name" autoComplete="name" />
      <Field label="Email" name="email" type="email" autoComplete="email" />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={8}
      />
    </AuthCard>
  )
}

export function LogInForm({ passwordReset }: { passwordReset: boolean }) {
  const router = useRouter()
  const { busy, error, run } = useAuthAction()
  return (
    <AuthCard
      title="Log in to IRIS"
      notice={passwordReset && "Password changed. Log in with the new one."}
      submit="Log in"
      busy={busy}
      error={error}
      onSubmit={async (form) => {
        const ok = await run(() =>
          authClient.signIn.email({
            email: text(form, "email"),
            password: text(form, "password"),
          })
        )
        if (ok) router.push("/dashboard")
      }}
      footer={
        <div className="flex w-full justify-between text-sm text-muted-foreground">
          <Link href="/signup" className="underline">
            Create an account
          </Link>
          <Link href="/forgot-password" className="underline">
            Forgot password?
          </Link>
        </div>
      }
    >
      <Field label="Email" name="email" type="email" autoComplete="email" />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
      />
    </AuthCard>
  )
}

export function ForgotPasswordForm() {
  const { busy, error, run } = useAuthAction()
  const [sentTo, setSentTo] = useState<string | null>(null)
  return (
    <AuthCard
      title="Reset your password"
      description="We will email you a link to set a new one."
      notice={
        sentTo &&
        `If ${sentTo} has an account, we sent it a link to reset the password.`
      }
      submit="Send reset link"
      busy={busy}
      error={error}
      onSubmit={async (form) => {
        const email = text(form, "email")
        const ok = await run(() =>
          authClient.requestPasswordReset({
            email,
            redirectTo: "/reset-password",
          })
        )
        if (ok) setSentTo(email)
      }}
      footer={
        <Link href="/login" className="text-sm underline">
          Back to log in
        </Link>
      }
    >
      <Field label="Email" name="email" type="email" autoComplete="email" />
    </AuthCard>
  )
}

export function ResetPasswordForm({ token }: { token: string | null }) {
  const router = useRouter()
  const { busy, error, run } = useAuthAction()
  if (!token)
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>This reset link is not valid</CardTitle>
          <CardDescription>
            It may have expired or been used already.{" "}
            <Link href="/forgot-password" className="underline">
              Ask for a new one
            </Link>
            .
          </CardDescription>
        </CardHeader>
      </Card>
    )
  return (
    <AuthCard
      title="Set a new password"
      submit="Set password"
      busy={busy}
      error={error}
      onSubmit={async (form) => {
        const ok = await run(() =>
          authClient.resetPassword({
            token,
            newPassword: text(form, "password"),
          })
        )
        if (ok) router.push("/login?reset=1")
      }}
    >
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={8}
      />
    </AuthCard>
  )
}

export function LogOutButton() {
  const router = useRouter()
  return (
    <Button
      variant="outline"
      onClick={async () => {
        await authClient.signOut()
        router.push("/login")
        router.refresh()
      }}
    >
      Log out
    </Button>
  )
}
