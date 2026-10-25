import type { NetworkInterfaceInfo } from "node:os"
import { describe, expect, it } from "vitest"
import { networkAddresses, reachableHosts } from "./access.ts"

const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
})

describe("reachableHosts", () => {
  it("lists Tailscale, then LAN, then the hostname, and skips loopback and container bridges", () => {
    const interfaces = {
      lo: [ipv4("127.0.0.1", true)],
      enp1s0: [ipv4("192.0.2.10")],
      tailscale0: [ipv4("100.64.0.2")],
      docker0: [ipv4("172.17.0.1")],
      "br-3f2a9c": [ipv4("172.18.0.1")],
      veth12ab: [ipv4("169.254.1.1")],
      virbr0: [ipv4("198.51.100.1")],
      podman0: [ipv4("10.88.0.1")],
      vboxnet0: [ipv4("198.51.100.2")],
      vmnet8: [ipv4("198.51.100.3")],
      cni0: [ipv4("10.42.0.1")],
      "flannel.1": [ipv4("10.42.0.0")],
    }
    expect(reachableHosts("0.0.0.0", interfaces, "build-box")).toStrictEqual(["100.64.0.2", "192.0.2.10", "build-box"])
  })

  it("returns a specific bind host as is", () => {
    expect(reachableHosts("100.64.0.2", {}, "build-box")).toStrictEqual(["100.64.0.2"])
  })
})

describe("networkAddresses", () => {
  it("names each address by its interface, Tailscale first", () => {
    const interfaces = {
      lo: [ipv4("127.0.0.1", true)],
      enp1s0: [ipv4("192.0.2.10")],
      tailscale0: [ipv4("100.64.0.2")],
      docker0: [ipv4("172.17.0.1")],
    }
    expect(networkAddresses(interfaces)).toStrictEqual([
      { name: "tailscale0", address: "100.64.0.2" },
      { name: "enp1s0", address: "192.0.2.10" },
    ])
  })
})
