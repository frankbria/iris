import { render, screen } from "@testing-library/react"

import Page from "@/app/page"

describe("portal home page", () => {
  it("identifies itself as the IRIS portal", () => {
    render(<Page />)
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(
      /IRIS/
    )
  })
})
