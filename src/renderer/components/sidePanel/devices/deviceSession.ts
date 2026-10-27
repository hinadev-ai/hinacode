import type { DeviceCommand, DeviceFrame } from "../../../../shared/device.ts"
import { errorMessage } from "../../../lib/errorMessage.ts"
import { callPromise } from "../../../lib/rpc.ts"

export type FrameShape = Pick<DeviceFrame, "width" | "height" | "orientation">

interface DeviceCallbacks {
  /** The first frame, and every frame whose size or orientation differs from the last. */
  readonly onShape: (shape: FrameShape) => void
  /** No frame request has succeeded for a while, or one has again after that. */
  readonly onStalled: (stalled: boolean) => void
  readonly onCommandError: (message: string) => void
}

const HIDDEN_POLL_MS = 2000
const STALL_MS = 5000
const MAX_BATCH = 128

/**
 * Streams a thread's device into a canvas and sends its input. One `device.frame` request is in flight at a time,
 * so the frame rate follows the link, and one `device.command` batch, so input queued meanwhile goes out together.
 */
export class DeviceSession {
  private readonly threadId: string
  private canvas: HTMLCanvasElement | null = null
  private readonly callbacks: DeviceCallbacks
  private timer: number | undefined
  private readonly watchdog: number
  private visible = true
  private disposed = false
  private polling = false
  private sequence = 0
  private shape = ""
  private failures = 0
  private lastSuccess = performance.now()
  private stalled = false
  private queue: DeviceCommand[] = []
  private sending = false

  constructor(threadId: string, callbacks: DeviceCallbacks) {
    this.threadId = threadId
    this.callbacks = callbacks
    // A request that never settles fails no catch, so the stall is judged by the clock.
    this.watchdog = window.setInterval(() => this.checkStall(), 1000)
    void this.poll()
  }

  /** `DeviceFrame` mounts the canvas once it has measured itself, so it can arrive after the stream starts. */
  setCanvas(canvas: HTMLCanvasElement | null) {
    if (this.canvas === canvas) return
    this.canvas = canvas
    // A still screen sends no new frame, so ask again for the newest one to fill the new canvas.
    this.sequence = 0
    if (canvas && !this.polling) this.schedule(0)
  }

  setVisible(visible: boolean) {
    if (this.visible === visible) return
    this.visible = visible
    this.lastSuccess = performance.now()
    this.checkStall()
    if (visible && !this.polling) this.schedule(0)
  }

  command(command: DeviceCommand) {
    if (this.disposed) return
    const previous = this.queue.at(-1)
    if (
      command.kind === "touch" &&
      command.phase === "move" &&
      previous?.kind === "touch" &&
      previous.phase === "move"
    ) {
      this.queue[this.queue.length - 1] = command
    } else if (
      command.kind === "scroll" &&
      previous?.kind === "scroll" &&
      Math.abs(previous.deltaX + command.deltaX) <= 10000 &&
      Math.abs(previous.deltaY + command.deltaY) <= 10000
    ) {
      this.queue[this.queue.length - 1] = {
        ...command,
        deltaX: previous.deltaX + command.deltaX,
        deltaY: previous.deltaY + command.deltaY,
      }
    } else this.queue.push(command)
    if (!this.sending) void this.flush()
  }

  dispose() {
    this.disposed = true
    this.queue = []
    window.clearTimeout(this.timer)
    window.clearInterval(this.watchdog)
  }

  private async flush() {
    this.sending = true
    try {
      while (!this.disposed && this.queue.length > 0) {
        const commands = this.queue.splice(0, MAX_BATCH)
        await callPromise("device.command", { threadId: this.threadId, commands })
      }
    } catch (cause) {
      this.queue = []
      if (!this.disposed) this.callbacks.onCommandError(errorMessage(cause))
    } finally {
      this.sending = false
    }
  }

  private async poll() {
    if (this.disposed || this.polling) return
    this.polling = true
    let delay = 0
    try {
      const { frame } = await callPromise("device.frame", {
        threadId: this.threadId,
        after: this.sequence,
        visible: this.visible,
      })
      if (this.disposed) return
      this.failures = 0
      this.lastSuccess = performance.now()
      this.checkStall()
      const canvas = this.canvas
      if (frame && canvas) {
        await this.paint(frame, canvas)
        if (this.canvas === canvas) this.sequence = frame.sequence
      }
      if (!this.visible) delay = HIDDEN_POLL_MS
    } catch {
      this.failures += 1
      delay = Math.min(2000, 250 * 2 ** (this.failures - 1))
    } finally {
      this.polling = false
      if (!this.disposed) this.schedule(delay)
    }
  }

  private async paint(frame: DeviceFrame, canvas: HTMLCanvasElement) {
    const bytes = Uint8Array.from(atob(frame.data), (character) => character.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: frame.mime }))
    try {
      if (this.disposed) return
      // The backing store is the frame's own pixels, never the element's box, so the image stays sharp.
      if (canvas.width !== frame.width) canvas.width = frame.width
      if (canvas.height !== frame.height) canvas.height = frame.height
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, frame.width, frame.height)
      const shape = `${frame.width}x${frame.height}:${frame.orientation}`
      if (shape !== this.shape) {
        this.shape = shape
        this.callbacks.onShape({ width: frame.width, height: frame.height, orientation: frame.orientation })
      }
    } finally {
      bitmap.close()
    }
  }

  private checkStall() {
    const stalled = this.visible && performance.now() - this.lastSuccess > STALL_MS
    if (stalled === this.stalled) return
    this.stalled = stalled
    this.callbacks.onStalled(stalled)
  }

  private schedule(delay: number) {
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => void this.poll(), delay)
  }
}
