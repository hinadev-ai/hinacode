import type { BrowserState } from "../../src/shared/browser.ts"
import type { RpcResponseEncoded } from "../../src/shared/contract.ts"
import type { Device, DeviceHost } from "../../src/shared/device.ts"
import type { PullRequest, PullRequestDetail } from "../../src/shared/domain.ts"
import type { Overrides } from "./scenarios.ts"

type Cloud = RpcResponseEncoded<"environments.list">["clouds"][number]

const cloud = (id: string, name: string, host: string, status: Cloud["status"], lastSeenAt: string | null): Cloud => ({
  id,
  name,
  host,
  port: 48081,
  relay: null,
  source: "pairing",
  createdAt: "2026-09-02T08:00:00.000Z",
  status,
  lastSeenAt,
})

export const clouds: ReadonlyArray<Cloud> = [
  { ...cloud("cloud-build", "Build box", "build-eu.hinadev.net", "connected", "@ago:0m"), protocol: 1 },
  cloud("cloud-gpu", "GPU workstation", "gpu-01.tail3c9a.ts.net", "connecting", null),
  cloud("cloud-studio", "Studio Mac mini", "studio.local", "offline", "@ago:3h"),
  cloud("cloud-ci", "CI runner", "ci-runner-2.hinadev.net", "unauthorized", null),
  cloud("cloud-old", "Old MacBook Air", "air.local", "incompatible", "@ago:2d"),
]

const GIB = 1024 ** 3

export const resources = (cpu: number, memory: number): RpcResponseEncoded<"system.resources"> => ({
  cpuCount: 12,
  memoryTotal: 32 * GIB,
  samples: Array.from({ length: 120 }, (_, index) => ({
    at: 1_000_000 + index * 5000,
    cpu: Math.min(1, cpu * (0.7 + 0.3 * Math.sin(index / 9) ** 2)),
    memoryUsed: 32 * GIB * memory * (0.95 + 0.05 * Math.cos(index / 4)),
    load: 12 * cpu,
  })),
  disks: [{ path: "/", used: 612 * GIB, free: 382 * GIB }],
})

export const GITHUB_AUTH: RpcResponseEncoded<"github.auth"> = {
  type: "signedIn",
  host: "github.com",
  login: "mika-tanaka",
}

const REPO = "https://github.com/hinadev-ai/hinacode/pull"

const pullRequest = (
  number: number,
  title: string,
  fields: Partial<typeof PullRequest.Encoded>,
): typeof PullRequest.Encoded => ({
  url: `${REPO}/${number}`,
  number,
  title,
  status: "open",
  checks: "passing",
  review: "approved",
  mergeable: "mergeable",
  author: "mika-tanaka",
  headRefName: `feat/${title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/-$/, "")}`,
  baseRefName: "main",
  additions: 214,
  deletions: 37,
  ...fields,
})

export const pullRequests = {
  open: pullRequest(1204, "Encrypt relay traffic end to end", {}),
  draft: pullRequest(1211, "Show relay latency in the machines popover", {
    status: "draft",
    checks: "pending",
    review: null,
    additions: 58,
    deletions: 4,
  }),
  merged: pullRequest(1188, "Rotate pairing tokens on sign-out", {
    status: "merged",
    mergedAt: "2026-11-03T09:12:00Z",
    additions: 96,
    deletions: 21,
  }),
  closed: pullRequest(1176, "Prototype a WebRTC transport", {
    status: "closed",
    checks: "failing",
    review: "reviewRequired",
    additions: 1180,
    deletions: 12,
  }),
  "checks-failing": pullRequest(1215, "Retry the relay handshake with backoff", {
    checks: "failing",
    review: "reviewRequired",
  }),
  "changes-requested": pullRequest(1219, "Pin the relay certificate per machine", { review: "changesRequested" }),
  conflicting: pullRequest(1222, "Move relay config into Settings > Connections", { mergeable: "conflicting" }),
} satisfies Record<string, typeof PullRequest.Encoded>

export const MAIN_PULL_REQUEST = pullRequests.open.url

const checkRuns = (failing: boolean): (typeof PullRequestDetail.Encoded)["checkRuns"] => [
  { name: "typecheck", status: "passing", url: `${REPO}/checks/1` },
  { name: "lint", status: "passing", url: `${REPO}/checks/2` },
  { name: "test", status: failing ? "failing" : "passing", url: `${REPO}/checks/3` },
  { name: "e2e (ubuntu-latest)", status: failing ? "pending" : "passing", url: `${REPO}/checks/4` },
  { name: "React Doctor", status: "skipped", url: null },
]

const detail = (base: typeof PullRequest.Encoded): typeof PullRequestDetail.Encoded => ({
  ...base,
  body: [
    "The relay forwarded frames in the clear between the desktop app and a paired machine.",
    "",
    "- Derive a session key from the pairing token with X25519 + HKDF",
    "- Seal every frame with XChaCha20-Poly1305 before it leaves the process",
    "- ADR 0021 records why we did not reuse TLS client certificates",
  ].join("\n"),
  baseRef: base.baseRefName,
  headRef: base.headRefName,
  head: "9c1e4b7a2f0d8e6c5b3a1f9e7d5c3b1a0f8e6d4c",
  checkRuns: checkRuns(base.checks === "failing"),
  changedFiles: 3,
  comments: [
    {
      id: "c1",
      author: "aoi-sato",
      authorKind: "human",
      body: "Should the nonce counter survive a reconnect? A fresh key per session sounds simpler.",
      createdAt: "2026-11-05T02:14:00Z",
      url: `${base.url}#discussion_r1`,
      location: { path: "src/main/relay/session.ts", line: 42, side: "RIGHT" },
    },
    {
      id: "c2",
      author: "mika-tanaka",
      authorKind: "you",
      body: "Agreed, rotated it per session in 9c1e4b7.",
      createdAt: "2026-11-05T03:40:00Z",
      url: `${base.url}#discussion_r2`,
      location: null,
    },
  ],
})

type PullRequestFileFixture = RpcResponseEncoded<"github.pullRequestFiles">[number]

const gitHeader = ({ path, status }: PullRequestFileFixture) =>
  status === "added"
    ? `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..3b18e51\n--- /dev/null\n+++ b/${path}\n`
    : `diff --git a/${path} b/${path}\nindex 8f2c1d4..e1a9b07 100644\n--- a/${path}\n+++ b/${path}\n`

const withGitHeader = (file: PullRequestFileFixture) => ({ ...file, patch: `${gitHeader(file)}${file.patch}\n` })

const filesWithoutHeaders: ReadonlyArray<PullRequestFileFixture> = [
  {
    path: "src/main/relay/crypto.ts",
    previousPath: null,
    status: "added",
    additions: 18,
    deletions: 0,
    binary: false,
    patch: [
      "@@ -0,0 +1,18 @@",
      '+import { hkdfSync, randomBytes } from "node:crypto"',
      '+import { xchacha20poly1305 } from "@noble/ciphers/chacha"',
      "+",
      "+export const deriveSessionKey = (sharedSecret: Uint8Array, pairingToken: string) =>",
      '+  new Uint8Array(hkdfSync("sha256", sharedSecret, pairingToken, "hinacode relay v1", 32))',
      "+",
      "+export const seal = (key: Uint8Array, plaintext: Uint8Array) => {",
      "+  const nonce = randomBytes(24)",
      "+  const sealed = xchacha20poly1305(key, nonce).encrypt(plaintext)",
      "+  return Buffer.concat([nonce, sealed])",
      "+}",
      "+",
      "+export const open = (key: Uint8Array, frame: Uint8Array) => {",
      "+  const nonce = frame.subarray(0, 24)",
      "+  return xchacha20poly1305(key, nonce).decrypt(frame.subarray(24))",
      "+}",
      "+",
      "+export const KEY_BYTES = 32",
    ].join("\n"),
  },
  {
    path: "src/main/relay/session.ts",
    previousPath: null,
    status: "modified",
    additions: 9,
    deletions: 4,
    binary: false,
    patch: [
      "@@ -36,14 +36,18 @@ export class RelaySession {",
      "   constructor(private readonly socket: WebSocket, private readonly token: string) {}",
      " ",
      "   send(frame: Uint8Array) {",
      "-    this.socket.send(frame)",
      "+    this.socket.send(seal(this.key, frame))",
      "   }",
      " ",
      "   receive(data: Uint8Array) {",
      "-    return data",
      "+    return open(this.key, data)",
      "   }",
      " ",
      "-  handshake() {",
      '-    this.socket.send(JSON.stringify({ type: "hello", token: this.token }))',
      "+  async handshake() {",
      "+    const { publicKey, sharedSecret } = await exchangeKeys(this.socket)",
      "+    this.key = deriveSessionKey(sharedSecret, this.token)",
      '+    this.socket.send(JSON.stringify({ type: "hello", publicKey }))',
      "+    this.ready = true",
      "+    this.flushQueue()",
      "   }",
      " }",
    ].join("\n"),
  },
  {
    path: "docs/adr/0021-relay-e2e-encryption.md",
    previousPath: null,
    status: "added",
    additions: 12,
    deletions: 0,
    binary: false,
    patch: [
      "@@ -0,0 +1,12 @@",
      "+# 0021 End-to-end encryption on the relay",
      "+",
      "+## Context",
      "+",
      "+The relay sees every frame between the desktop app and a paired machine.",
      "+",
      "+## Decision",
      "+",
      "+Each session derives a key from an X25519 exchange and the pairing token, and seals frames",
      "+with XChaCha20-Poly1305. We do not use TLS client certificates, because the relay terminates TLS.",
      "+",
      "+Status: accepted",
    ].join("\n"),
  },
]

export const pullRequestFiles: RpcResponseEncoded<"github.pullRequestFiles"> = filesWithoutHeaders.map(withGitHeader)

export const pullRequestGuide = {
  head: "9c1e4b7a2f0d8e6c5b3a1f9e7d5c3b1a0f8e6d4c",
  model: "claude-sonnet-5-5",
  generatedAt: "2026-11-05T04:00:00.000Z",
  summary: "Seals every relay frame with a per-session key and records the decision in an ADR.",
  groups: [
    {
      key: "core",
      label: "Relay encryption",
      summary: "Key derivation and frame sealing.",
      category: "core",
      critical: true,
      filePaths: ["src/main/relay/crypto.ts", "src/main/relay/session.ts"],
      lineNotes: [
        {
          path: "src/main/relay/session.ts",
          side: "additions",
          line: 46,
          text: "Frames queued before the handshake finishes are flushed here.",
        },
      ],
    },
    { key: "docs", label: "Decision record", category: "docs", filePaths: ["docs/adr/0021-relay-e2e-encryption.md"] },
  ],
} satisfies RpcResponseEncoded<"pullRequestGuides.get">["guide"]

export const pullRequestLinks: RpcResponseEncoded<"pullRequests.all"> = Object.values(pullRequests).map(
  (each, index) => ({
    id: `link-${each.number}`,
    threadId: "$MAIN",
    url: each.url,
    createdAt: `2026-11-0${1 + (index % 5)}T08:00:00.000Z`,
    watch: null,
  }),
)

const byUrl = <A>(value: (pr: typeof PullRequest.Encoded) => A) =>
  Object.fromEntries(Object.values(pullRequests).map((each) => [each.url, { result: value(each) }]))

export const pullRequestOverrides: Overrides = {
  "github.pullRequest": { by: "url", replies: byUrl((each) => each) },
  "github.pullRequestDetail": { by: "url", replies: byUrl(detail) },
  "github.pullRequestFiles": { result: pullRequestFiles },
  "github.fileContent": { result: null },
  "pullRequestGuides.get": { result: { guide: pullRequestGuide, job: null } },
}

export const attachedDevice: typeof Device.Encoded = {
  id: "ios:6F1C2A9E-3B4D-4E5F-8A7B-1C2D3E4F5A6B",
  platform: "ios",
  name: "iPhone 17 Pro",
  osVersion: "26.1",
  state: "booted",
  slim: { disabled: 41, total: 63 },
  memoryBytes: 1_450_000_000,
  ownerThreadId: "$MAIN",
}

const devices: ReadonlyArray<typeof Device.Encoded> = [
  attachedDevice,
  {
    id: "ios:0B8D7C6E-5F4A-4B3C-9D2E-1F0A9B8C7D6E",
    platform: "ios",
    name: "iPad Air 13-inch (M3)",
    osVersion: "26.1",
    state: "shutdown",
    slim: null,
    memoryBytes: null,
    ownerThreadId: null,
  },
  {
    id: "android:Pixel_9_API_36",
    platform: "android",
    name: "Pixel 9",
    osVersion: "16",
    state: "shutdown",
    slim: null,
    memoryBytes: null,
    ownerThreadId: null,
  },
]

const models: (typeof DeviceHost.Encoded)["models"] = [
  {
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-1",
    name: "iPhone 17 Pro",
    family: "iPhone",
    osVersion: "26.1",
  },
  {
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPad-Air-13-inch-M3",
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-1",
    name: "iPad Air 13-inch (M3)",
    family: "iPad",
    osVersion: "26.1",
  },
]

type Check = (typeof DeviceHost.Encoded)["checks"][number]

const check = (requirement: Check["requirement"], state: Check["state"] = "ready"): Check => {
  const needed: Record<Check["requirement"], Check["needed"]> = {
    xcode: "ios",
    iosRuntime: "ios",
    simslim: "recommended",
    axe: "recommended",
    audioCapture: "recommended",
    androidSdk: "android",
    androidImage: "android",
    avd: "android",
  }
  const manual = requirement === "xcode" || requirement === "androidSdk" || requirement === "audioCapture"
  return { requirement, state, needed: needed[requirement], fix: manual ? "manual" : "install" }
}

const readyChecks: ReadonlyArray<Check> = [
  check("xcode"),
  check("iosRuntime"),
  check("simslim"),
  check("axe"),
  check("androidSdk"),
  check("androidImage"),
  check("avd"),
]

const staleHolder = {
  client: "kalan-laptop",
  clientId: "client-laptop",
  threadId: "7d0c4f7e-1d3b-4a51-9a39-3c3d2f6c9e10",
  threadTitle: "Fix the login screen on small phones",
  seenAt: Date.parse("2026-11-10T09:00:00.000Z"),
}

export const devicesHost = {
  ready: { ios: { kind: "ready" }, android: { kind: "ready" }, checks: readyChecks, devices, models },
  missingTools: {
    ios: { kind: "ready" },
    android: { kind: "ready" },
    checks: readyChecks.map((each) =>
      each.requirement === "simslim" || each.requirement === "axe" ? check(each.requirement, "missing") : each,
    ),
    devices,
    models,
  },
  missingXcode: {
    ios: { kind: "missing", tool: "xcode" },
    android: { kind: "ready" },
    checks: [
      check("xcode", "missing"),
      check("iosRuntime", "missing"),
      check("simslim", "missing"),
      check("axe"),
      ...readyChecks.filter((each) => each.needed === "android"),
    ],
    devices: devices.filter((each) => each.platform === "android"),
    models: [],
  },
  unsupported: {
    ios: { kind: "unsupported", reason: "notMac" },
    android: { kind: "missing", tool: "androidSdk" },
    checks: [
      check("xcode", "unsupported"),
      check("iosRuntime", "unsupported"),
      check("simslim", "unsupported"),
      check("axe", "unsupported"),
      check("androidSdk", "missing"),
      check("androidImage", "missing"),
      check("avd", "missing"),
    ],
    devices: [],
    models: [],
  },
  staleHolder: {
    ios: { kind: "ready" },
    android: { kind: "ready" },
    checks: readyChecks,
    devices: devices.map((each) => (each.platform === "android" ? { ...each, holders: [staleHolder] } : each)),
    models,
  },
} satisfies Record<string, typeof DeviceHost.Encoded>

export const deviceFrame: NonNullable<RpcResponseEncoded<"device.frame">["frame"]> = {
  sequence: 1,
  mime: "image/png",
  data: "asset:phone.png",
  width: 390,
  height: 844,
  orientation: "portrait",
}

export const remoteBrowserState = (patch: Partial<typeof BrowserState.Encoded>): typeof BrowserState.Encoded => ({
  url: "http://localhost:5173/checkout",
  title: "Fernwood Coffee · Checkout",
  loading: false,
  back: true,
  forward: false,
  failure: null,
  pick: { kind: "idle" },
  ...patch,
})

export const remoteFrame: NonNullable<RpcResponseEncoded<"browser.frame">["frame"]> = {
  sequence: 1,
  jpeg: "asset:page.jpg",
  width: 384,
  height: 880,
}

export const vmHost = {
  connected: {
    status: "connected",
    provider: "boat",
    url: "https://boat.hinadev.net",
    sandboxes: 2,
    maxSandboxes: 8,
    templates: [
      { name: "default", cpus: 2, memoryMiB: 4096 },
      { name: "desktop-large", cpus: 4, memoryMiB: 8192 },
    ],
  },
  notConfigured: { status: "notConfigured", provider: "boat" },
  unreachable: {
    status: "unreachable",
    provider: "boat",
    url: "https://boat.hinadev.net",
    message: "connect ECONNREFUSED 10.0.4.12:8443",
  },
} satisfies Record<string, RpcResponseEncoded<"vm.host">>

export const runningVm = {
  agent: {
    status: "running",
    provider: "boat",
    sandboxId: "sbx-7f3a",
    template: "default",
    profile: "off",
    control: "agent",
  },
  userWaiting: {
    status: "running",
    provider: "boat",
    sandboxId: "sbx-7f3a",
    template: "default",
    profile: "off",
    control: "user",
    agentWaiting: true,
  },
} satisfies Record<string, RpcResponseEncoded<"vm.get">>
