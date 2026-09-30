import nextJest from "next/jest.js"

// next/jest wires SWC transforms, CSS/font mocks and the `@/` path alias.
const createJestConfig = nextJest({ dir: "./" })

export default createJestConfig({
  testEnvironment: "jsdom",
  testMatch: ["<rootDir>/__tests__/**/*.test.ts?(x)"],
})
