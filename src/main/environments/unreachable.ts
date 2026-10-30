export type DialTarget = { readonly host: string; readonly port: number } | { readonly relay: string }

export const unreachableMessage = (target: DialTarget, code: string | undefined, reason: string) => {
  // FIXME: Cloudflare answers 502 or 530 while the tunnel is down
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
