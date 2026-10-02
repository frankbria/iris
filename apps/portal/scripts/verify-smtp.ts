import { createMailTransport } from "../lib/mail"

/**
 * Deploy readiness check (#273): connect to the SMTP server and authenticate, so a bad
 * `SMTP_URL` fails the deploy instead of only being logged at the first sign-up.
 * BetterAuth logs a failed send and carries on. Exit 0 = ready, 1 = not (reason on stderr).
 *
 * Bounded by its own timer: nodemailer waits up to 2 minutes for a host that never
 * answers, and a deploy step must fail, not hang.
 */
const TIMEOUT_MS = Number(process.env.SMTP_VERIFY_TIMEOUT_MS || 15_000)

async function main() {
  const transport = createMailTransport()
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      transport.verify(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer within ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
    transport.close()
  }
}

main().then(
  () => console.log("smtp: ready"),
  (err: Error) => {
    console.error(`smtp: ${err.message}`)
    process.exit(1)
  }
)
