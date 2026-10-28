import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { AgentProfile, ProviderId } from "../../shared/agent.ts"
import { m } from "../paraglide/messages.js"
import { accountsAtom, type EnvironmentId } from "./rpc.ts"
import { useSettings } from "./settings.ts"

/** The provider's added accounts, in the order they were added. */
export function useProviderAccounts(environment: EnvironmentId, provider: ProviderId): ReadonlyArray<AgentProfile> {
  const all = AsyncResult.getOrElse(useAtomValue(accountsAtom(environment)), (): ReadonlyArray<AgentProfile> => [])
  return all.filter((account) => account.provider === provider)
}

/** What the agent's own login is called: the user's name for it, or "Default". */
export function useDefaultAccountName(environment: EnvironmentId, provider: ProviderId): string {
  return useSettings(environment).defaultAccountName[provider] ?? m.account_default()
}
