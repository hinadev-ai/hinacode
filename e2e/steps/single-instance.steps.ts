import { expect } from "@playwright/test"
import { Then } from "../support/fixtures.ts"

Then("launching hinacode again on the same profile exits", async ({ app }) => {
  expect(await app.launchAgain(15_000)).toBe(0)
})
