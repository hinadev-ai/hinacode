import type { RelayMachine } from "@shared/relayMachines.ts"
import { AppState } from "react-native"
import { create } from "zustand"
import { setServers, storedServers, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import {
  applyRelayMachines,
  claimRelaySignIn,
  fetchRelayMachines,
  type RelayAccount,
  signOutRelayDevice,
  startRelaySignIn,
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
  /** Opens the approval page and waits for it, saving the account only once approved. Returns why it failed, or null. */
  readonly signIn: (input: {
    readonly serviceUrl: string
    readonly deviceName: string
    readonly openUrl: (url: string) => Promise<unknown>
  }) => Promise<string | null>
  readonly sync: () => Promise<void>
  /** Forgets the account and the servers it added. */
  readonly signOut: () => Promise<void>
}

const REFUSED_SYNC_INTERVAL_MS = 15_000

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
    signIn: async ({ serviceUrl, deviceName, openUrl }) => {
      signInAttempt++
      const attempt = signInAttempt
      const started = await startRelaySignIn(serviceUrl, deviceName, fetch)
      if (started._tag === "failed") return started.message
      const { deviceCode, url, interval, expiresAt } = started.signIn
      await openUrl(url)
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, interval * 1000))
        if (attempt !== signInAttempt) return null
        if (Date.now() >= expiresAt) return copy("mobile_relay_sign_in_expired")
        const claim = await claimRelaySignIn(serviceUrl, deviceCode, fetch)
        if (claim._tag === "expired") return attempt === signInAttempt ? copy("mobile_relay_sign_in_expired") : null
        if (claim._tag === "pending") continue
        const next = { serviceUrl, credential: claim.credential }
        if (attempt !== signInAttempt) {
          void signOutRelayDevice(next, fetch)
          return null
        }
        account = next
        set({ serviceUrl })
        await saveRelayAccount(next)
        if (account === next) await get().sync()
        return null
      }
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
