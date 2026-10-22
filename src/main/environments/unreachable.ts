interface Address {
  readonly host: string
  readonly port: number
}

/**
 * Turns why a cloud could not be reached into a sentence that says what to check next. `code` is the
 * socket error's `code`, such as `ECONNREFUSED`; `reason` is shown as is for any other code.
 */
export const unreachableMessage = ({ host, port }: Address, code: string | undefined, reason: string) => {
  switch (code) {
    case "ECONNREFUSED":
      return `Nothing is listening on ${host}:${port}. Check that hinacode serve is running there and uses port ${port}.`
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `${host} did not answer. Check that this computer is on the same network or tailnet as it.`
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Could not find ${host}. Use its Tailscale or LAN address instead.`
    default:
      return `Could not reach ${host}:${port}: ${reason}`
  }
}
