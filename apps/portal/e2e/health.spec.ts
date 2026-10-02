import { expect, test } from "@playwright/test"

// The readiness route the image's HEALTHCHECK and the deploy wait on (#273).
test("/api/health is 200 when auth, master key and database work, and is never cached", async ({
  request,
}) => {
  const res = await request.get("/api/health")
  expect(res.status()).toBe(200)
  expect(await res.text()).toBe("ok")
  expect(res.headers()["cache-control"]).toBe("no-store")
})
