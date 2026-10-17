import { Effect, Option, Schema } from "effect"

export const PREFERENCES_KEY = "hinacode.preferences"

const AppearanceSchema = Schema.Literals(["system", "light", "dark"])
export type Appearance = typeof AppearanceSchema.Type
export const appearances = AppearanceSchema.literals

const HomeTabSchema = Schema.Literals(["inbox", "threads", "archived"])
export type HomeTab = typeof HomeTabSchema.Type

const NotificationPreferences = Schema.Struct({
  completed: Schema.Boolean,
  needsInput: Schema.Boolean,
  failed: Schema.Boolean,
})

/** The phone's own settings. The desktop's settings stay on the desktop. */
export interface Preferences {
  readonly appearance: Appearance
  readonly notifications: typeof NotificationPreferences.Type
  readonly homeTab: HomeTab
}

export const defaultPreferences: Preferences = {
  appearance: "system",
  notifications: { completed: true, needsInput: true, failed: true },
  homeTab: "inbox",
}

const withDefault = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)))

/** Keys an older app never wrote take their defaults. */
const Stored = Schema.Struct({
  appearance: withDefault(AppearanceSchema, defaultPreferences.appearance),
  notifications: withDefault(NotificationPreferences, defaultPreferences.notifications),
  homeTab: withDefault(HomeTabSchema, defaultPreferences.homeTab),
})

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Stored))

export const parsePreferences = (raw: string | null): Preferences =>
  raw === null ? defaultPreferences : Option.getOrElse(decode(raw), () => defaultPreferences)
