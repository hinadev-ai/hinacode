import type { DeviceAudio, DeviceId } from "../../../../shared/device.ts"
import { errorMessage } from "../../../lib/errorMessage.ts"
import { callPromise } from "../../../lib/rpc.ts"

const BUFFER_SECONDS = 0.15
const MAX_QUEUED_SECONDS = 0.5
const POLL_SPACING_MS = 50

export class DeviceSound {
  private readonly threadId: string
  private readonly deviceId: DeviceId
  private readonly onError: (message: string) => void
  private readonly context = new AudioContext({ latencyHint: "interactive" })
  private after = -1
  private playAt = 0
  private timer: number | undefined
  private disposed = false

  constructor(threadId: string, deviceId: DeviceId, onError: (message: string) => void) {
    this.threadId = threadId
    this.deviceId = deviceId
    this.onError = onError
    void this.context.resume()
    void this.poll()
  }

  dispose() {
    this.disposed = true
    window.clearTimeout(this.timer)
    void this.context.close()
  }

  private async poll() {
    const started = performance.now()
    try {
      const audio = await callPromise("device.audio", {
        threadId: this.threadId,
        deviceId: this.deviceId,
        after: this.after,
      })
      if (this.disposed) return
      this.play(audio)
    } catch (error) {
      if (!this.disposed) this.onError(errorMessage(error))
      return
    }
    const wait = Math.max(0, POLL_SPACING_MS - (performance.now() - started))
    this.timer = window.setTimeout(() => void this.poll(), wait)
  }

  private play({ rate, channels, chunks }: DeviceAudio) {
    const last = chunks.at(-1)
    if (!last) return
    this.after = last.sequence
    const binary = chunks.map((chunk) => atob(chunk.data)).join("")
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const samples = new Int16Array(bytes.buffer, 0, bytes.length >> 1)
    const frames = Math.floor(samples.length / channels)
    if (frames === 0) return
    const buffer = this.context.createBuffer(channels, frames, rate)
    for (let channel = 0; channel < channels; channel++) {
      const data = buffer.getChannelData(channel)
      for (let frame = 0; frame < frames; frame++) data[frame] = samples[frame * channels + channel]! / 32768
    }
    const now = this.context.currentTime
    if (this.playAt < now || this.playAt > now + MAX_QUEUED_SECONDS) this.playAt = now + BUFFER_SECONDS
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.context.destination)
    source.start(this.playAt)
    this.playAt += buffer.duration
  }
}
