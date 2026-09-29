import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import { createRequire } from "node:module"

// eslint-config-next asks eslint-plugin-react to "detect" the React version, and
// detection calls context.getFilename(), which ESLint 10 removed. Pinning the
// installed version skips detection. Read, never hard-coded, so it cannot drift.
const reactVersion = createRequire(import.meta.url)(
  "react/package.json"
).version

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  { settings: { react: { version: reactVersion } } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
])

export default eslintConfig
