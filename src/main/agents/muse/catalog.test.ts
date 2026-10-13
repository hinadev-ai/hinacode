import { describe, expect, test } from "@effect/vitest"
import { toAccount, toModelInfo } from "./catalog.ts"

// A `model/list` row from muse 1.4.7.
const wonder = {
  contextLimit: 1007997,
  cost: null,
  defaultReasoningEffort: "high",
  description: null,
  displayLabel: "muse-wonder-full-1.0",
  isActive: false,
  isDefault: false,
  modelId: "muse-wonder-full-1.0",
  outputLimit: 128000,
  profileId: "tbh",
  providerId: "meta",
  reasoningEffortVariants: [],
  releaseDate: "2026-10-12",
  variants: ["minimal", "low", "medium", "high", "xhigh", "max"],
}

describe("toModelInfo", () => {
  test("spells a label equal to the id in title case and reads efforts from variants", () => {
    expect(toModelInfo(wonder)).toStrictEqual({
      id: "muse-wonder-full-1.0",
      label: "Muse Wonder Full 1.0",
      provider: "muse",
      efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      fastMode: false,
      autoMode: true,
    })
  })

  test("keeps a label Meta wrote itself", () => {
    expect(toModelInfo({ ...wonder, displayLabel: "Muse Wonder" }).label).toBe("Muse Wonder")
  })

  test("has no efforts and no default effort when the row names none", () => {
    expect(toModelInfo({ modelId: "fake-model", displayLabel: "fake-model" })).toMatchObject({
      label: "Fake Model",
      efforts: [],
      defaultEffort: null,
    })
  })
})

describe("toAccount", () => {
  test("reads a Meta login as a subscription with the label as email and no plan", () => {
    expect(toAccount({ credentialRequired: true, label: "someone@example.com", state: "accountLogin" })).toStrictEqual({
      type: "subscription",
      email: "someone@example.com",
      plan: null,
      organization: null,
    })
    expect(toAccount({ credentialRequired: true, state: "accountLogin" })).toMatchObject({ email: null })
  })

  test("reads a stored or environment key as an API key", () => {
    expect(toAccount({ credentialRequired: true, state: "apiKey" })).toStrictEqual({ type: "apiKey" })
    expect(toAccount({ credentialRequired: true, state: "envKey" })).toStrictEqual({ type: "apiKey" })
  })

  test("is signed out without a credential, unless the endpoint needs none", () => {
    expect(toAccount({ credentialRequired: true, state: "loggedOut" })).toStrictEqual({ type: "signedOut" })
    expect(toAccount({ credentialRequired: false, state: "loggedOut" })).toStrictEqual({
      type: "external",
      service: "Muse Code",
    })
  })

  test("names an unknown credential lane by its state", () => {
    expect(toAccount({ credentialRequired: true, state: "workloadIdentity" })).toStrictEqual({
      type: "external",
      service: "workloadIdentity",
    })
  })
})
