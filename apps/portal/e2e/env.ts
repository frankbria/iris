/**
 * Where the E2E run finds its services. Defaults match docker-compose.dev.yml.
 * - `IRIS_TEST_DATABASE_URL` (required): an admin URL. The run creates and
 *   migrates its own `iris_portal_e2e` database next to it.
 * - `E2E_SMTP_URL` / `E2E_MAILPIT_URL`: Mailpit's SMTP and HTTP API.
 * - `E2E_PORT`: the port `next start` listens on.
 */
export function e2eEnv() {
  const admin = process.env.IRIS_TEST_DATABASE_URL
  if (!admin)
    throw new Error("Set IRIS_TEST_DATABASE_URL (see docker-compose.dev.yml)")
  const port = Number(process.env.E2E_PORT ?? 3100)
  const databaseUrl = new URL(admin)
  databaseUrl.pathname = "/iris_portal_e2e"
  return {
    adminUrl: admin,
    databaseUrl: databaseUrl.toString(),
    port,
    baseURL: `http://localhost:${port}`,
    smtpUrl: process.env.E2E_SMTP_URL ?? "smtp://127.0.0.1:51025",
    mailpitUrl: process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:58025",
  }
}
