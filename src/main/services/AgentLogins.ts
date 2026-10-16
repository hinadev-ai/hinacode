import { Context, Effect, Layer } from "effect"
import type { AgentAccount, ProviderId } from "../../shared/agent.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import type { AgentError, AgentProvider } from "../agents/provider.ts"
import { AgentAccounts } from "./AgentAccounts.ts"
import type { NotFoundError, PersistenceError } from "./errors.ts"

/** Who each account is signed in as. hinacode never signs in or out; the user does that in a terminal. */
export class AgentLogins extends Context.Service<
  AgentLogins,
  {
    /** `accountId` null is the CLI's own login. */
    readonly account: (
      provider: ProviderId,
      accountId: string | null,
    ) => Effect.Effect<AgentAccount, AgentError | PersistenceError | NotFoundError>
  }
>()("hinacode/AgentLogins") {}

const make = Effect.gen(function* () {
  const accounts = yield* AgentAccounts
  const providers: Record<ProviderId, AgentProvider> = {
    claude: yield* ClaudeProvider,
    codex: yield* CodexProvider,
    muse: yield* MuseProvider,
  }

  return AgentLogins.of({
    account: (provider, accountId) =>
      Effect.gen(function* () {
        if (accountId === null) return yield* providers[provider].account(null)
        const account = yield* accounts.get(accountId)
        return yield* providers[account.provider].account(yield* accounts.home(accountId))
      }),
  })
})

export const layer = Layer.effect(AgentLogins, make)
