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
  /** Null while signed out. */
  readonly serviceUrl: string | null
  readonly syncedAt: string | null
  /** How many machines the last sync listed. */
  readonly machines: number | null
  /** Why the last sync failed. */
  readonly error: string | null
  /** The relay refused the credential, so this phone was signed out and has to sign in again. */
  readonly unauthorized: boolean
  readonly syncing: boolean
  /** Reads the saved account once at launch and syncs with it. */
  readonly restore: () => Promise<void>
  /**
   * Opens the relay's sign-in page through `authenticate`, which resolves with the URL the browser redirected to, or
   * null when the person closed it. Returns why it failed, or null when it signed in or was cancelled.
   */
  readonly signIn: (input: {
    readonly serviceUrl: string
    readonly deviceName: string
    readonly random: Uint8Array
    readonly authenticate: (url: string, redirectUri: string) => Promise<string | null>
  }) => Promise<string | null>
  readonly sync: () => Promise<void>
  /** Forgets the account and the servers it added. */
  readonly signOut: () => Promise<void>
}

const REFUSED_SYNC_INTERVAL_MS = 15_000
const SIGN_IN_REDIRECT = "hinacode://signed-in"

const signedOut = { serviceUrl: null, syncedAt: null, machines: null, error: null, unauthorized: false }

// Outside the store, so no screen ever renders the credential.
let account: RelayAccount | null = null
let inFlight: Promise<void> | null = null
let signInAttempt = 0
let refusedSyncTimer: ReturnType<typeof setInterval> | undefined

function applyMachines(machines: readonly RelayMachine[]) {
  const before = storedServers()
  const after = applyRelayMachines(before, machines, newServerId)
  if (JSON.stringify(after) === JSON.stringify(before)) return
  setServers(after)
  // The dropped servers' projects and threads leave the lists, as when one is forgotten.
  if (after.length < before.length && useConnection.getState().servers.length > 0) {
    void useThreads.getState().load()
    void usePullRequests.getState().load()
  }
}

export const useRelayAccount = create<RelayAccountState>()((set, get) => {
  const run = async (current: RelayAccount) => {
    set({ syncing: true })
    try {
      const result = await fetchRelayMachines(current, fetch)
      // Signed out or in again while the list was on its way.
      if (account !== current) return
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

/**
 * A machine that rotates its token closes the phone's sockets with 4002 and publishes the new token to the relay a
 * moment later. So while a relay server refuses its token, sync now and every 15 seconds in the foreground; a
 * changed token makes `setServers` redial it.
 */
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
