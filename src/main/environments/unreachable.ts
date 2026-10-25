/** Where a dial went: a direct address of the cloud, or the hostname of its relay. */
export type DialTarget = { readonly host: string; readonly port: number } | { readonly relay: string }

/**
 * Turns why a cloud could not be reached into a sentence that says what to check next. `code` is the
 * socket error's `code`, such as `ECONNREFUSED`; `reason` is shown as is for any other code.
 */
export const unreachableMessage = (target: DialTarget, code: string | undefined, reason: string) => {
  // Cloudflare answers 502 or 530 while the tunnel is down, so the reason says no more than this sentence.
  if ("relay" in target) {
    return `${target.relay} did not answer. Check that the relay is connected in Settings > Remote on that machine.`
  }
  const { host, port } = target
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
