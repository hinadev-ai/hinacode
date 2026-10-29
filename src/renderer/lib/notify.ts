import { toast } from "sonner"
import type { ThreadAlert } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { callPromise } from "./rpc.ts"

const chimes: Record<ThreadAlert, ReadonlyArray<number>> = {
  completed: [660, 880],
  needsInput: [880, 880],
  failed: [523, 392],
}

const NOTE_GAP_S = 0.12
const NOTE_LENGTH_S = 0.25
const PEAK_GAIN = 0.12

let audio: AudioContext | undefined

const playChime = (alert: ThreadAlert) => {
  audio ??= new AudioContext()
  const context = audio
  void context.resume()
  chimes[alert].forEach((frequency, index) => {
    const at = context.currentTime + index * NOTE_GAP_S
    const oscillator = new OscillatorNode(context, { type: "sine", frequency })
    const gain = new GainNode(context, { gain: 0 })
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, at + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_LENGTH_S)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start(at)
    oscillator.stop(at + NOTE_LENGTH_S)
  })
}

export type Surface = "desktop" | "toast"

const showToast: Record<ThreadAlert, typeof toast.warning> = {
  completed: toast,
  needsInput: toast.warning,
  failed: toast.error,
}
const LINGERING_TOAST_MS = 10_000

interface Notice {
  readonly alert: ThreadAlert
  readonly title: string
  readonly body: string
  readonly sound: boolean
  readonly tag?: string
  readonly onClick?: () => void
}

export const notify = (surface: Surface, { alert, title, body, sound, tag, onClick }: Notice) => {
  if (surface === "desktop") {
    const notification = new Notification(title, { body, silent: true, ...(tag === undefined ? {} : { tag }) })
    notification.addEventListener("click", () => {
      void callPromise("app.focus", undefined)
      onClick?.()
    })
  } else {
    showToast[alert](title, {
      description: body,
      ...(tag === undefined ? {} : { id: tag }),
      ...(alert === "completed" ? {} : { duration: LINGERING_TOAST_MS }),
      ...(onClick === undefined ? {} : { action: { label: m.notification_open(), onClick } }),
    })
  }
  if (sound) playChime(alert)
}
