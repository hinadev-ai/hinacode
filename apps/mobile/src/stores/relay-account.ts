import type { RelayMachine } from "@shared/relayMachines.ts"
import { AppState } from "react-native"
import { create } from "zustand"
import { setServers, storedServers, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import {
  applyRelayMachines,
  codeFromCallback,
  exchangeSignInCode,
  fetchRelayMachines,
  fetchRelayProfile,
  pkcePair,
  type RelayAccount,
  signInUrl,
  signOutRelayDevice,
} from "@/lib/relay-account"
import { clearRelayAccount, loadRelayAccount, saveRelayAccount } from "@/lib/storage"
import { newServerId } from "@/lib/stored-target"
import { usePullRequests } from "@/stores/pull-requests"
import { useThreads } from "@/stores/threads"

interface RelayAccountState {
  readonly serviceUrl: string | null
  readonly syncedAt: string | null
  readonly name: string | null
  readonly avatarUrl: string | null
  readonly machines: number | null
  readonly error: string | null
  readonly unauthorized: boolean
  readonly syncing: boolean
  readonly restore: () => Promise<void>
  readonly signIn: (input: {
    readonly serviceUrl: string
    readonly deviceName: string
    readonly random: Uint8Array
    readonly authenticate: (url: string, redirectUri: string) => Promise<string | null>
  }) => Promise<string | null>
  readonly sync: () => Promise<void>
  readonly signOut: () => Promise<void>
}

const REFUSED_SYNC_INTERVAL_MS = 15_000
const SIGN_IN_REDIRECT = "hinacode://signed-in"

const signedOut = {
  serviceUrl: null,
  syncedAt: null,
  name: null,
  avatarUrl: null,
  machines: null,
  error: null,
  unauthorized: false,
}

let account: RelayAccount | null = null
let inFlight: Promise<void> | null = null
let signInAttempt = 0
let refusedSyncTimer: ReturnType<typeof setInterval> | undefined

function applyMachines(machines: readonly RelayMachine[]) {
  const before = storedServers()
  const after = applyRelayMachines(before, machines, newServerId)
  if (JSON.stringify(after) === JSON.stringify(before)) return
  setServers(after)
  if (after.length < before.length && useConnection.getState().servers.length > 0) {
    void useThreads.getState().load()
    void usePullRequests.getState().load()
  }
}

export const useRelayAccount = create<RelayAccountState>()((set, get) => {
  const run = async (current: RelayAccount) => {
    set({ syncing: true })
    try {
      const [result, profile] = await Promise.all([
        fetchRelayMachines(current, fetch),
        fetchRelayProfile(current, fetch),
      ])
      if (account !== current) return
      if (profile !== null) set(profile)
      switch (result._tag) {
        case "machines":
          applyMachines(result.machines)
          set({
            syncedAt: new Date().toISOString(),
            machines: result.machines.length,
            error: null,
            unauthorized: false,
          })
          return
        case "unauthorized":
          set({ error: copy("mobile_relay_signed_out_elsewhere"), unauthorized: true })
          return
        case "failed":
          set({ error: copy("mobile_relay_sync_failed", { message: result.message }) })
      }
    } finally {
      set({ syncing: false })
    }
  }

  return {
    ...signedOut,
    syncing: false,
    restore: async () => {
      account = await loadRelayAccount()
      if (account === null) return
      set({ serviceUrl: account.serviceUrl })
      await get().sync()
    },
    signIn: async ({ serviceUrl, deviceName, random, authenticate }) => {
      signInAttempt++
      const attempt = signInAttempt
      const { verifier, challenge } = pkcePair(random)
      const callback = await authenticate(
        signInUrl(serviceUrl, { redirectUri: SIGN_IN_REDIRECT, challenge, name: deviceName }),
        SIGN_IN_REDIRECT,
      )
      if (callback === null || attempt !== signInAttempt) return null
      const code = codeFromCallback(callback)
      if (code === null) return copy("mobile_relay_bad_answer")
      const result = await exchangeSignInCode(serviceUrl, code, verifier, fetch)
      if (result._tag === "failed") return attempt === signInAttempt ? result.message : null
      const next = { serviceUrl, credential: result.credential }
      if (attempt !== signInAttempt) {
        void signOutRelayDevice(next, fetch)
        return null
      }
      account = next
      set({ serviceUrl })
      await saveRelayAccount(next)
      if (account === next) await get().sync()
      return null
    },
    sync: () => {
      if (account === null) return Promise.resolve()
      inFlight ??= run(account).finally(() => {
        inFlight = null
      })
      return inFlight
    },
    signOut: async () => {
      signInAttempt++
      if (account !== null) void signOutRelayDevice(account, fetch)
      account = null
      set(signedOut)
      applyMachines([])
      await clearRelayAccount()
    },
  }
})

// oxlint-disable-next-line hinacode/no-comments
// A machine that rotates its token closes the phone's sockets with 4002 and publishes the new token to the relay a moment later, so a refused relay server is synced until the new token arrives.
function syncWhileRefused() {
  const refused =
    account !== null &&
    !useRelayAccount.getState().unauthorized &&
    useConnection.getState().servers.some((server) => server.source === "relay" && server.status === "unauthorized")
  if (!refused) {
    clearInterval(refusedSyncTimer)
    refusedSyncTimer = undefined
    return
  }
  if (refusedSyncTimer !== undefined) return
  refusedSyncTimer = setInterval(() => {
    if (AppState.currentState === "active") void useRelayAccount.getState().sync()
  }, REFUSED_SYNC_INTERVAL_MS)
  void useRelayAccount.getState().sync()
}

useConnection.subscribe(syncWhileRefused)
useRelayAccount.subscribe(syncWhileRefused)
