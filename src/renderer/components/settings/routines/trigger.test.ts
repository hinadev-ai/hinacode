import { describe, expect, test } from "@effect/vitest"
import type { RoutineTrigger } from "../../../../shared/domain.ts"
import { emptyTriggerDraft, fromTrigger, parseList, parseLogins, toTrigger, type TriggerDraft } from "./trigger.ts"

const draft = (patch: Partial<TriggerDraft>): TriggerDraft => ({ ...emptyTriggerDraft, ...patch })

describe("parseList", () => {
  test.each([
    ["", []],
    ["  ", []],
    ["acme/api", ["acme/api"]],
    ["acme/api, acme/web", ["acme/api", "acme/web"]],
    ["acme/api acme/web\nacme/cli", ["acme/api", "acme/web", "acme/cli"]],
    [" ,acme/api,, acme/api ,", ["acme/api"]],
  ])("%j becomes %j", (text, list) => {
    expect(parseList(text)).toEqual(list)
  })
})

describe("parseLogins", () => {
  test("drops a leading @ and the duplicates it leaves", () => {
    expect(parseLogins("@octocat, octocat hubot\n@hubot")).toEqual(["octocat", "hubot"])
  })

  test("drops a lone @", () => {
    expect(parseLogins("@ ,")).toEqual([])
  })
})

describe("toTrigger", () => {
  test("is none without an event", () => {
    expect(toTrigger(draft({ fromUsers: "octocat" }))).toEqual({ valid: true, trigger: null })
  })

  test("is invalid when an event has no sender", () => {
    expect(toTrigger(draft({ event: "github.issue_comment", fromUsers: " @ , " }))).toEqual({ valid: false })
  })

  test("builds the trigger from the fields", () => {
    expect(
      toTrigger(
        draft({
          event: "github.issue_comment",
          fromUsers: "@octocat, hubot",
          scopes: "acme/api acme/api",
          contains: "  @hina  ",
          continueConversation: false,
        }),
      ),
    ).toEqual({
      valid: true,
      trigger: {
        event: "github.issue_comment",
        fromUsers: ["octocat", "hubot"],
        scopes: ["acme/api"],
        contains: "@hina",
        continuation: "new",
      },
    })
  })

  test("leaves contains empty when the field is blank", () => {
    const result = toTrigger(draft({ event: "github.issue_opened", fromUsers: "octocat", contains: "   " }))
    expect(result).toMatchObject({ valid: true, trigger: { contains: null, scopes: [], continuation: "conversation" } })
  })
})

describe("fromTrigger", () => {
  test("reads no trigger as the empty draft", () => {
    expect(fromTrigger(null)).toEqual(emptyTriggerDraft)
  })

  test("round-trips a trigger", () => {
    const trigger: RoutineTrigger = {
      event: "github.pull_request_comment",
      fromUsers: ["octocat", "hubot"],
      scopes: ["acme/api"],
      contains: "@hina",
      continuation: "new",
    }
    expect(fromTrigger(trigger)).toEqual({
      event: "github.pull_request_comment",
      fromUsers: "octocat, hubot",
      scopes: "acme/api",
      contains: "@hina",
      continueConversation: false,
    })
    expect(toTrigger(fromTrigger(trigger))).toEqual({ valid: true, trigger })
  })
})
