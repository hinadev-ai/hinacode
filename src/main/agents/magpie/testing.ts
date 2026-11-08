import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { Secrets } from "../../services/Secrets.ts"
import * as Settings from "../../services/Settings.ts"

export const magpieDependencies = (secrets: Record<string, string> = {}) => {
  const stored = new Map(Object.entries(secrets))
  return Layer.mergeAll(
    Settings.layer(mkdtempSync(join(tmpdir(), "kk-magpie-settings-"))),
    Layer.succeed(
      Secrets,
      Secrets.of({
        get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
        has: (name) => Effect.sync(() => stored.has(name)),
        set: (name, value) => Effect.sync(() => void stored.set(name, value)),
        clear: (name) => Effect.sync(() => void stored.delete(name)),
      }),
    ),
  )
}
