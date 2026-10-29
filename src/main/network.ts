import { networkInterfaces } from "node:os"
import type { NetworkAddress } from "../shared/domain.ts"

type Interfaces = ReturnType<typeof networkInterfaces>

const isTailscale = (address: string) => address.startsWith("100.")

const isVirtualBridge = (name: string) => /^(docker|br-|veth|virbr|cni|flannel|podman|vboxnet|vmnet)/.test(name)

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

export const tailscaleAddress = (interfaces: Interfaces = networkInterfaces()): string | null =>
  networkAddresses(interfaces).find((a) => isTailscale(a.address))?.address ?? null
