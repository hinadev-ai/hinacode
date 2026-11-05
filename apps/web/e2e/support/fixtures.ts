import { test as base } from "@playwright/test"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import {
  closeMachine,
  createRepo,
  type Machine,
  type Relay,
  relayListing,
  serveWebApp,
  startMachine,
  startRelay,
} from "./stack.ts"

export interface WebStack {
  readonly appUrl: string
  readonly relay: Relay
  readonly machine: Machine
}

interface TestFixtures {
  readonly web: WebStack
  readonly uniqueName: (name: string) => string
  readonly repo: string
}

interface WorkerFixtures {
  readonly stack: WebStack
}

// FIXME: react/rules-of-hooks mistakes Playwright's use callback for React's hook
/* oxlint-disable react/rules-of-hooks, no-empty-pattern */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  stack: [
    async ({}, use) => {
      const machine = await startMachine("Web E2E Machine")
      const relay = await startRelay([relayListing(machine)], randomBytes(16).toString("hex"))
      const webApp = await serveWebApp()
      try {
        await use({ appUrl: webApp.url, relay, machine })
      } finally {
        await webApp.close()
        await relay.close()
        await closeMachine(machine)
      }
    },
    { scope: "worker" },
  ],
  web: async ({ stack }, use) => {
    await stack.machine.start()
    await use(stack)
  },
  uniqueName: async ({}, use) => {
    const suffix = randomBytes(3).toString("hex")
    await use((name) => `${name}-${suffix}`)
  },
  repo: async ({ web, uniqueName }, use) => use(createRepo(join(web.machine.userData, "repos", uniqueName("repo")))),
})
/* oxlint-enable react/rules-of-hooks, no-empty-pattern */

export { expect } from "@playwright/test"
