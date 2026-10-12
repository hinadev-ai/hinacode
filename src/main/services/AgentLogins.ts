import { Context, Duration, Effect, Exit, Fiber, Layer, Scope } from "effect"
import type { AgentAccount, ProviderId } from "../../shared/agent.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { AgentError, type AgentProvider, type SignIn } from "../agents/provider.ts"
import { AgentAccounts } from "./AgentAccounts.ts"
import { AgentRunner } from "./AgentRunner.ts"
import type { AccountInUseError, NotFoundError, PersistenceError } from "./errors.ts"
import { Events } from "./Events.ts"

const SIGN_IN_TIMEOUT = Duration.minutes(10)

type LookupError = PersistenceError | NotFoundError

/** Who each account is signed in as, and signing added accounts in and out. */
export class AgentLogins extends Context.Service<
  AgentLogins,
  {
    /** `accountId` null is the CLI's own login. */
    readonly account: (
      provider: ProviderId,
      accountId: string | null,
    ) => Effect.Effect<AgentAccount, AgentError | LookupError>
    /**
     * Starts signing an added account in, replacing a sign-in it already waits on. The outcome arrives as
     * an `account.signIn` push.
     */
    readonly signIn: (accountId: string) => Effect.Effect<SignIn, AgentError | LookupError>
    readonly submitCode: (accountId: string, code: string) => Effect.Effect<void, AgentError>
    readonly cancelSignIn: (accountId: string) => Effect.Effect<void>
    readonly signOut: (accountId: string) => Effect.Effect<void, AgentError | LookupError>
    /** Refused while a thread uses the account. Signs it out before its home is deleted. */
    readonly remove: (accountId: string) => Effect.Effect<void, LookupError | AccountInUseError>
  }
>()("kkcode/AgentLogins") {}

interface Pending {
  readonly scope: Scope.Closeable
  readonly signIn: SignIn
  fiber?: Fiber.Fiber<void>
}

const make = Effect.gen(function* () {
  const layerScope = yield* Effect.scope
  const accounts = yield* AgentAccounts
  const runner = yield* AgentRunner
  const push = yield* Events
  const providers: Record<ProviderId, AgentProvider> = {
    claude: yield* ClaudeProvider,
    codex: yield* CodexProvider,
  }
  const pending = new Map<string, Pending>()

  const homeOf = (accountId: string) =>
    Effect.gen(function* () {
      const account = yield* accounts.get(accountId)
      const home = (yield* accounts.home(accountId))!
      return { provider: providers[account.provider], home }
    })

  const cancelSignIn = (accountId: string) =>
    Effect.suspend(() => {
      const current = pending.get(accountId)
      pending.delete(accountId)
      if (current === undefined) return Effect.void
      return current.fiber === undefined
        ? Scope.close(current.scope, Exit.void)
        : Effect.asVoid(Fiber.interrupt(current.fiber))
    })

  const signIn = (accountId: string) =>
    Effect.gen(function* () {
      yield* cancelSignIn(accountId)
      const { provider, home } = yield* homeOf(accountId)
      const scope = yield* Scope.make()
      const started = yield* provider.signIn(home).pipe(
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      )
      const entry: Pending = { scope, signIn: started }
      pending.set(accountId, entry)
      entry.fiber = yield* started.completed.pipe(
        Effect.timeoutOrElse({
          duration: SIGN_IN_TIMEOUT,
          orElse: () => Effect.fail(new AgentError({ provider: provider.id, message: "The sign-in timed out" })),
        }),
        Effect.match({ onSuccess: () => null, onFailure: (error) => error.message }),
        Effect.tap(() => runner.forgetLimits(provider.id, accountId)),
        Effect.flatMap((error) => push.publish({ type: "account.signIn", accountId, error })),
        Effect.ensuring(
          Effect.suspend(() => {
            if (pending.get(accountId) === entry) pending.delete(accountId)
            return Scope.close(scope, Exit.void)
          }),
        ),
        Effect.forkIn(layerScope),
      )
      return started
    })

  const submitCode = (accountId: string, code: string) =>
    Effect.suspend(() => {
      const submit = pending.get(accountId)?.signIn.submitCode
      return submit
        ? submit(code)
        : Effect.fail(new AgentError({ provider: "kkcode", message: "No sign-in is waiting for a code" }))
    })

  return AgentLogins.of({
    account: (provider, accountId) =>
      Effect.gen(function* () {
        if (accountId === null) return yield* providers[provider].account(null)
        const { provider: owner, home } = yield* homeOf(accountId)
        return yield* owner.account(home)
      }),
    signIn,
    submitCode,
    cancelSignIn,
    signOut: (accountId) =>
      homeOf(accountId).pipe(
        Effect.flatMap(({ provider, home }) => provider.signOut(home).pipe(Effect.as(provider.id))),
        Effect.flatMap((provider) => runner.forgetLimits(provider, accountId)),
      ),
    remove: (accountId) =>
      cancelSignIn(accountId).pipe(
        Effect.andThen(
          accounts.remove(accountId, (account, home) =>
            providers[account.provider]
              .signOut(home)
              .pipe(Effect.catch((error) => Effect.logWarning("sign-out before removing the account failed", error))),
          ),
        ),
      ),
  })
})

export const layer = Layer.effect(AgentLogins, make)
