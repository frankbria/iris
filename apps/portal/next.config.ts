import path from "node:path"

import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The portal image (Dockerfile.portal, #273) ships `.next/standalone`: a server.js
  // plus only the node_modules it traces. Traced from the repo root, because the
  // portal imports ../../../src directly; the same root Turbopack finds from the
  // root lockfile.
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
}

export default nextConfig
