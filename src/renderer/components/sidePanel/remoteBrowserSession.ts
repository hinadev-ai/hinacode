import type { BrowserCommand, BrowserFrame, BrowserState, BrowserViewport } from "../../../shared/browser.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { callPromise } from "../../lib/rpc.ts"

interface BrowserCallbacks {
  readonly onState: (state: BrowserState) => void
  readonly onFailure: (url: string, message: string) => void
}

export const browserViewport = (width: number, height: number): BrowserViewport => ({
  width: Math.max(1, Math.min(2560, Math.round(width))),
  height: Math.max(1, Math.min(2560, Math.round(height))),
})

export class RemoteBrowserSession {
  private readonly threadId: string
  private readonly canvas: HTMLCanvasElement
  private readonly callbacks: BrowserCallbacks
  private session: Promise<{ sessionId: string }> | null = null
  private generation = 0
  private timer: number | undefined
  private visible = false
  private disposed = false
  private failed = false
  private sequence = 0
  private metadata = ""
  private url = ""
  private viewport: BrowserViewport
  private queue: BrowserCommand[] = []
  private sending = false
  private polling = false

  constructor(threadId: string, canvas: HTMLCanvasElement, viewport: BrowserViewport, callbacks: BrowserCallbacks) {
    this.threadId = threadId
    this.canvas = canvas
    this.viewport = viewport
    this.callbacks = callbacks
  }

  navigate(url: string) {
    this.url = url
    if (this.session === null || this.failed) this.restart(url)
    else this.command({ kind: "navigate", url })
  }

  restart(url: string) {
    this.closeSession()
    if (this.disposed) return
    this.url = url
    this.failed = false
    const generation = this.generation
    this.canvas.width = this.viewport.width
    this.canvas.height = this.viewport.height
    const session = callPromise("browser.open", { threadId: this.threadId, url, ...this.viewport })
    this.session = session
    void session.then(
      () => {
        if (this.current(generation)) void this.poll(generation)
      },
      (cause: unknown) => this.fail(cause, generation),
    )
  }

  resize(viewport: BrowserViewport) {
    if (this.viewport.width === viewport.width && this.viewport.height === viewport.height) return
    this.viewport = viewport
    this.command({ kind: "resize", ...viewport })
  }

  setVisible(visible: boolean) {
    if (this.visible === visible) return
    this.visible = visible
    if (!visible) {
      this.command({ kind: "release" })
      this.command({ kind: "pick", enabled: false })
    }
    if (this.session !== null && !this.failed) this.schedule(0, this.generation)
  }

  command(command: BrowserCommand) {
    if (this.session === null || this.disposed || this.failed) return
    const previous = this.queue.at(-1)
    if (
      command.kind === "pointer" &&
      command.type === "mouseMoved" &&
      previous?.kind === "pointer" &&
      previous.type === "mouseMoved"
    ) {
      this.queue[this.queue.length - 1] = command
    } else if (
      command.kind === "pointer" &&
      command.type === "mouseWheel" &&
      previous?.kind === "pointer" &&
      previous.type === "mouseWheel" &&
      previous.modifiers === command.modifiers &&
      previous.buttons === command.buttons &&
      Math.abs(previous.deltaX + command.deltaX) <= 10000 &&
      Math.abs(previous.deltaY + command.deltaY) <= 10000
    ) {
      this.queue[this.queue.length - 1] = {
        ...command,
        deltaX: previous.deltaX + command.deltaX,
        deltaY: previous.deltaY + command.deltaY,
      }
    } else this.queue.push(command)
    if (!this.sending) void this.flush(this.generation)
  }

  dispose() {
    this.disposed = true
    this.closeSession()
  }

  private current(generation: number) {
    return !this.disposed && !this.failed && this.generation === generation
  }

  private async flush(generation: number) {
    const opening = this.session
    if (opening === null) return
    this.sending = true
    try {
      const { sessionId } = await opening
      while (this.current(generation)) {
        if (this.queue.length === 0) break
        const commands = this.queue.splice(0, 128)
        await callPromise("browser.command", { threadId: this.threadId, sessionId, commands })
      }
    } catch (cause) {
      this.fail(cause, generation)
    } finally {
      if (this.generation === generation) this.sending = false
    }
  }

  private async poll(generation: number) {
    const opening = this.session
    if (!opening || !this.current(generation) || this.polling) return
    this.polling = true
    try {
      const { sessionId } = await opening
      if (!this.current(generation)) return
      const { state, frame } = await callPromise("browser.frame", {
        threadId: this.threadId,
        sessionId,
        after: this.sequence,
        visible: this.visible,
      })
      if (!this.current(generation)) return
      if (state.url.startsWith("http://") || state.url.startsWith("https://")) this.url = state.url
      const metadata = JSON.stringify(state)
      if (metadata !== this.metadata) {
        this.metadata = metadata
        this.callbacks.onState(state)
      }
      if (frame && this.visible) {
        await this.paint(frame, generation)
        if (this.current(generation) && this.visible) this.sequence = frame.sequence
      }
    } catch (cause) {
      this.fail(cause, generation)
    } finally {
      if (this.generation === generation) {
        this.polling = false
        if (this.current(generation)) this.schedule(this.visible ? 0 : 5000, generation)
      }
    }
  }

  private async paint(frame: BrowserFrame, generation: number) {
    const image = new Image()
    image.src = `data:image/jpeg;base64,${frame.jpeg}`
    await image.decode()
    if (!this.current(generation) || !this.visible) return
    if (this.canvas.width !== frame.width) this.canvas.width = frame.width
    if (this.canvas.height !== frame.height) this.canvas.height = frame.height
    this.canvas.getContext("2d")?.drawImage(image, 0, 0, frame.width, frame.height)
  }

  private schedule(delay: number, generation: number) {
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => void this.poll(generation), delay)
  }

  private fail(cause: unknown, generation: number) {
    if (!this.current(generation)) return
    this.failed = true
    this.queue = []
    window.clearTimeout(this.timer)
    this.callbacks.onFailure(this.url, errorMessage(cause))
  }

  private closeSession() {
    this.generation += 1
    window.clearTimeout(this.timer)
    const opening = this.session
    this.session = null
    this.queue = []
    this.sending = false
    this.polling = false
    this.sequence = 0
    this.metadata = ""
    if (opening) {
      void opening
        .then(({ sessionId }) => callPromise("browser.close", { threadId: this.threadId, sessionId }))
        .catch(() => {})
    }
  }
}
