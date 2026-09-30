# @iris/portal

The hosted IRIS portal: sign-up, organizations, API keys, BYOK provider keys and
billing ([ADR 0001](../../docs/adr/0001-hosted-architecture.md)). Next.js with the
shadcn Nova preset: gray palette, Hugeicons, Nunito Sans.

Run from the repo root (npm workspaces):

```bash
npm run dev   -w @iris/portal
npm test      -w @iris/portal
npm run lint  -w @iris/portal
npm run build -w @iris/portal   # also type-checks
npm run e2e   -w @iris/portal   # Playwright; needs the build and the services below
```

## Accounts (#249)

Email + password through BetterAuth. The policy lives in the shared
`createAuth()` (`src/auth/config.ts`), which the portal imports directly and the API
also uses. A session requires a verified address, account mail goes over SMTP, and
the auth routes are rate-limited. The server reads:

| Variable                             | Meaning                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                 | Signs sessions                                              |
| `BETTER_AUTH_URL`                    | Public origin. With `https`, the session cookie is `Secure` |
| `DATABASE_URL` / `DATABASE_URL_FILE` | Postgres, migrated with `npm run db:migrate`                |
| `SMTP_URL`, `SMTP_FROM`              | Mail transport (e.g. `smtps://user:pass@host`) and sender   |

They are read on first request, so `next build` needs none of them. For local
development, `docker compose -f docker-compose.dev.yml up -d --wait` starts Postgres
and Mailpit. Point `SMTP_URL` at `smtp://127.0.0.1:51025` and read the mail at
http://127.0.0.1:58025.

The E2E suite (`e2e/`) runs `next start` over the build against a fresh
`iris_portal_e2e` database and reads every mail from Mailpit. It needs
`IRIS_TEST_DATABASE_URL`, an admin URL.

- Each test sends its own random `X-Forwarded-For`. The limiter counts per client
  IP, so without that header the tests would share one counter.
- On WSL, a connect to a closed port on 127.0.0.1 hangs instead of being
  refused. Playwright's check for a server already on the port therefore costs about
  2 minutes before the run starts.

## Organizations (#250)

The org is the tenant. BetterAuth's organization plugin, configured in `createAuth()`:

- A user's first sign-in creates a personal org they own, and every new session starts
  in an org the user belongs to (`session.activeOrganizationId`).
- Owners and admins invite by email. The mail links to `/accept-invitation/<id>`, which
  only the invited address (verified) can accept. Roles: owner, admin, member.
- Every tenant page reads its org through `requireOrg()` (`lib/org.ts`), which takes it
  from the session, never from the request. BetterAuth checks membership on every call.
- Deleting an org is disabled until offboarding (#349).

Add UI components from this directory with `npx shadcn@latest add <name>`.

- The preset API no longer offers `gray`. The color tokens in `app/globals.css` are
  shadcn's registry `gray` values (`https://ui.shadcn.com/r/colors/gray.json`).
- `eslint.config.mjs` pins `settings.react.version` to the installed React. Without
  it, `eslint-plugin-react` (via `eslint-config-next`) crashes on ESLint 10.
