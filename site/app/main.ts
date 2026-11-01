import type { HinacodeBridge } from "../../src/shared/contract.ts"

async function bridgeFor(params: URLSearchParams): Promise<HinacodeBridge> {
  const live = params.get("live")
  if (import.meta.env.DEV && live) {
    const { liveBridge } = await import("./live.ts")
    const session = liveBridge(live, params.get("token") ?? "")
    Object.assign(window, { hinacodeRecording: session.recording })
    return session.bridge
  }
  const { replayBridge } = await import("./replay.ts")
  return replayBridge(params)
}

Object.defineProperty(window, "hinacode", { value: await bridgeFor(new URLSearchParams(location.search)) })
await import("../../src/renderer/main.tsx")
