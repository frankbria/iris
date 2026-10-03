/**
 * @jest-environment node
 */
import { GET } from "@/app/.well-known/security.txt/route"

/** The route handler itself (#348), with and without a security contact. */
describe("GET /.well-known/security.txt", () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it("serves the file as text/plain when a security contact is configured", async () => {
    process.env.IRIS_SECURITY_CONTACT = "mailto:security@example.com"
    process.env.BETTER_AUTH_URL = "https://portal.example.com"
    const res = GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    const text = await res.text()
    expect(text).toMatch(/^Contact: mailto:security@example\.com$/m)
    const expires = /^Expires: (\S+)$/m.exec(text)![1]
    const days = (Date.parse(expires) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(364)
    expect(days).toBeLessThanOrEqual(365)
    expect(text).toMatch(/^Policy: https:\/\/portal\.example\.com\/contact$/m)
  })

  it("reads the portal URL like auth does, from BETTER_AUTH_URL_FILE too", async () => {
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-url-"))
    const file = path.join(dir, "url")
    fs.writeFileSync(file, "https://portal.example.com\n")
    process.env.IRIS_SECURITY_CONTACT = "mailto:security@example.com"
    delete process.env.BETTER_AUTH_URL
    process.env.BETTER_AUTH_URL_FILE = file
    try {
      const res = GET()
      expect(res.status).toBe(200)
      expect(await res.text()).toMatch(
        /^Policy: https:\/\/portal\.example\.com\/contact$/m
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is a 404 without one, rather than a file with no Contact", async () => {
    delete process.env.IRIS_SECURITY_CONTACT
    const res = GET()
    expect(res.status).toBe(404)
    expect(await res.text()).not.toMatch(/Contact:/)
  })
})
