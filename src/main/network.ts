import { BlockList, isIPv4 } from "node:net"
import { networkInterfaces } from "node:os"
import type { NetworkAddress } from "../shared/domain.ts"

type Interfaces = ReturnType<typeof networkInterfaces>

const isTailscale = (address: string) => address.startsWith("100.")

const isVirtualBridge = (name: string) =>
  /^(docker|br-|veth|virbr|cni|flannel|podman|vboxnet|vmnet|bridge[1-9]\d\d)/.test(name)

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

const privateRanges = new BlockList()
for (const [network, prefix] of [
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["100.64.0.0", 10],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const)
  privateRanges.addSubnet(network, prefix, "ipv4")

export const isPrivateAddress = (address: string) => privateRanges.check(address, isIPv4(address) ? "ipv4" : "ipv6")

export const privateAddresses = (interfaces: Interfaces = networkInterfaces()): ReadonlyArray<string> =>
  networkAddresses(interfaces)
    .map((a) => a.address)
    .filter(isPrivateAddress)

export const tailscaleAddress = (interfaces: Interfaces = networkInterfaces()): string | null =>
  networkAddresses(interfaces).find((a) => isTailscale(a.address))?.address ?? null
