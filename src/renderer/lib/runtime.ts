import { m } from "../paraglide/messages.js"

export const inBrowser = () => window.hinacode.runtime.kind === "web"

const webMachineName = () => {
  const { runtime } = window.hinacode
  return runtime.kind === "web" ? runtime.machine : null
}

export const thisMachineName = () => webMachineName() ?? m.environment_this_machine()

export const thisMachineNameInline = () => webMachineName() ?? m.environment_this_machine_inline()
