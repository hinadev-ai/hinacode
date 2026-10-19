import { Schema } from "effect"
import type { VmPasskeyKind } from "../../../../shared/domain.ts"

export class PasskeyError extends Schema.TaggedError<PasskeyError>()("PasskeyError", { message: Schema.String }) {}

export interface GuestRequest {
  readonly kind: VmPasskeyKind
  readonly requestId: number
  readonly requestDetailsJson: string
  readonly origin: string
}

export type CeremonyRequest = {
  readonly kind: VmPasskeyKind
  readonly origin: string
  readonly rpId: string
  readonly requestDetailsJson: string
} & { readonly __brand: "CeremonyRequest" }

export type CeremonyOutcome =
  | { readonly type: "ok"; readonly responseJson: string }
  | { readonly type: "error"; readonly name: string; readonly message: string }

export const ceremonyError = (name: string, message: string): CeremonyOutcome => ({ type: "error", name, message })

export const notAllowed = (message: string): CeremonyOutcome => ceremonyError("NotAllowedError", message)

const RequestDetails = Schema.fromJsonString(
  Schema.Struct({
    rpId: Schema.optional(Schema.String),
    rp: Schema.optional(Schema.Struct({ id: Schema.optional(Schema.String) })),
    challenge: Schema.String,
  }),
)
const decodeDetails = Schema.decodeUnknownOption(RequestDetails)

const isLocalHttp = (url: URL) =>
  url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")

/**
 * Checks a guest request before a ceremony window opens. The `rpId` must be the origin host or a parent of
 * it, which is the scope rule a browser applies on one machine. A relay has to apply it by hand, because it
 * chooses the ceremony origin itself.
 */
export const validateRequest = (request: GuestRequest): CeremonyRequest | { readonly error: string } => {
  const details = decodeDetails(request.requestDetailsJson)
  if (details._tag === "None") return { error: "The VM sent a passkey request HinaCode does not understand" }
  let url: URL
  try {
    url = new URL(request.origin)
  } catch {
    return { error: `The VM sent a passkey request with an unreadable origin: ${request.origin}` }
  }
  if (url.protocol !== "https:" && !isLocalHttp(url)) {
    return { error: `Passkeys only run on secure origins, not ${request.origin}` }
  }
  const rpId = (request.kind === "create" ? details.value.rp?.id : details.value.rpId) ?? url.hostname
  if (rpId === "" || !(url.hostname === rpId || url.hostname.endsWith(`.${rpId}`))) {
    return { error: `The passkey request asks for ${rpId}, which ${request.origin} may not claim` }
  }
  return {
    kind: request.kind,
    origin: url.origin,
    rpId,
    requestDetailsJson: request.requestDetailsJson,
  } as CeremonyRequest
}

export const GuestMessage = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("request"),
      kind: Schema.Literals(["get", "create"]),
      requestId: Schema.Number,
      requestDetailsJson: Schema.String,
      origin: Schema.String,
    }),
    Schema.Struct({ type: Schema.Literal("canceled"), requestId: Schema.Number }),
    Schema.Struct({ type: Schema.Literal("timeout"), requestId: Schema.Number }),
  ]),
)
export type GuestMessage = typeof GuestMessage.Type

export const decodeGuestMessage = Schema.decodeUnknownOption(GuestMessage)

export const CeremonyResult = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ responseJson: Schema.String }),
    Schema.Struct({ error: Schema.Struct({ name: Schema.String, message: Schema.String }) }),
  ]),
)

export const decodeCeremonyResult = Schema.decodeUnknownOption(CeremonyResult)
