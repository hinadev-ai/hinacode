import { networkInterfaces } from "node:os"
import type { NetworkAddress } from "../shared/domain.ts"

type Interfaces = ReturnType<typeof networkInterfaces>

const isTailscale = (address: string) => address.startsWith("100.")

/** Bridges into containers and VMs on this machine, which no phone or other desktop can route to. */
const isVirtualBridge = (name: string) => /^(docker|br-|veth|virbr|cni|flannel|podman|vboxnet|vmnet)/.test(name)

/** IPv4 addresses on this machine a phone could reach, Tailscale first. Nothing on loopback, since a phone is never on it. */
export const networkAddresses = (interfaces: Interfaces = networkInterfaces()): ReadonlyArray<NetworkAddress> => {
  const addresses = Object.entries(interfaces)
    .filter(([name]) => !isVirtualBridge(name))
    .flatMap(([name, nets]) =>
      (nets ?? [])
        .filter((net) => net.family === "IPv4" && !net.internal)
        .map((net) => ({ name, address: net.address })),
    )
  return [...addresses.filter((a) => isTailscale(a.address)), ...addresses.filter((a) => !isTailscale(a.address))]
}

/** This machine's Tailscale address, the one a listener binds when the user has not picked one. */
export const tailscaleAddress = (interfaces: Interfaces = networkInterfaces()): string | null =>
  networkAddresses(interfaces).find((a) => isTailscale(a.address))?.address ?? null
