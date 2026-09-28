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
```

Add UI components from this directory with `npx shadcn@latest add <name>`.

- The preset API no longer offers `gray`. The color tokens in `app/globals.css` are
  shadcn's registry `gray` values (`https://ui.shadcn.com/r/colors/gray.json`).
- ESLint is pinned to 9: `eslint-plugin-react` (via `eslint-config-next`) crashes
  on ESLint 10.
