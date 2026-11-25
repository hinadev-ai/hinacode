import { Array as Arr } from "effect"
import { type RoutineTrigger, TriggerEvent } from "../../../../shared/domain.ts"
import { m } from "../../../paraglide/messages.js"

export const triggerEvents = TriggerEvent.literals

export const triggerEventLabel = {
  "github.issue_opened": m.routines_trigger_github_issue_opened,
  "github.pull_request_opened": m.routines_trigger_github_pull_request_opened,
  "github.issue_comment": m.routines_trigger_github_issue_comment,
  "github.pull_request_comment": m.routines_trigger_github_pull_request_comment,
  "slack.mention": m.routines_trigger_slack_mention,
} satisfies Record<TriggerEvent, () => string>

export type TriggerSource = "github" | "slack"

export const triggerSource = (event: TriggerEvent): TriggerSource => (event.startsWith("slack.") ? "slack" : "github")

interface TriggerField {
  readonly label: () => string
  readonly placeholder: string
}

interface TriggerFields {
  readonly from: TriggerField
  readonly scopes: TriggerField
  readonly containsPlaceholder: string
  readonly hint: (() => string) | null
}

export const triggerFields: Record<TriggerSource, TriggerFields> = {
  github: {
    from: { label: m.routines_trigger_from_label, placeholder: "octocat, hubot" },
    scopes: { label: m.routines_trigger_scopes_label, placeholder: "acme/api" },
    containsPlaceholder: "@hina",
    hint: null,
  },
  slack: {
    from: { label: m.routines_trigger_from_label, placeholder: "U012AB3CDE" },
    scopes: { label: m.routines_trigger_channels_label, placeholder: "C012AB3CDE" },
    containsPlaceholder: "deploy",
    hint: m.routines_trigger_slack_ids_hint,
  },
}

export const isTriggerEvent = (value: unknown): value is TriggerEvent => triggerEvents.some((event) => event === value)

export interface TriggerDraft {
  readonly event: TriggerEvent | null
  readonly fromUsers: string
  readonly scopes: string
  readonly contains: string
  readonly continueConversation: boolean
}

export const emptyTriggerDraft: TriggerDraft = {
  event: null,
  fromUsers: "",
  scopes: "",
  contains: "",
  continueConversation: true,
}

const unique = (values: ReadonlyArray<string>) => [...new Set(values.filter((value) => value !== ""))]

export const parseList = (text: string) => unique(text.split(/[\s,]+/))

export const parseLogins = (text: string) => unique(text.split(/[\s,]+/).map((login) => login.replace(/^@/, "")))

export type TriggerResult =
  | { readonly valid: false }
  | { readonly valid: true; readonly trigger: RoutineTrigger | null }

export function toTrigger(draft: TriggerDraft): TriggerResult {
  if (draft.event === null) return { valid: true, trigger: null }
  const fromUsers = parseLogins(draft.fromUsers)
  if (!Arr.isArrayNonEmpty(fromUsers)) return { valid: false }
  const contains = draft.contains.trim()
  return {
    valid: true,
    trigger: {
      event: draft.event,
      fromUsers,
      scopes: parseList(draft.scopes),
      contains: contains === "" ? null : contains,
      continuation: draft.continueConversation ? "conversation" : "new",
    },
  }
}

export const fromTrigger = (trigger: RoutineTrigger | null): TriggerDraft =>
  trigger === null
    ? emptyTriggerDraft
    : {
        event: trigger.event,
        fromUsers: trigger.fromUsers.join(", "),
        scopes: trigger.scopes.join(", "),
        contains: trigger.contains ?? "",
        continueConversation: trigger.continuation === "conversation",
      }
