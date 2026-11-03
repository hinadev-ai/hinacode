import { m } from "../paraglide/messages.js"

export const inBrowser = () => window.hinacode.runtime.kind === "web"

const webMachine = () => {
  const { runtime } = window.hinacode
  return runtime.kind === "web" ? runtime.machine : null
}

const webMachineName = () => webMachine()?.name ?? null

export const homeEnvironmentId = () => webMachine()?.id ?? null

export const switchMachine = () => {
  const { runtime } = window.hinacode
  return runtime.kind === "web" ? runtime.switchMachine : null
}

export const thisMachineName = () => webMachineName() ?? m.environment_this_machine()

export const thisMachineNameInline = () => webMachineName() ?? m.environment_this_machine_inline()
