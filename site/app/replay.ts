import type { HinacodeBridge, PushEvent, RpcEnvelope } from "../../src/shared/contract.ts"
import type { Locale } from "../../src/shared/domain.ts"
import { desktopShim } from "./desktop.ts"
import type { RecordedCall, RecordedEvent, Recording } from "./recording.ts"

export const PLAY_MESSAGE = "hinacode-demo:play"

const AUTOPLAYED = new Set(["threads.send"])
const WAITS_FOR_VISITOR = new Set(["approvals.respond", "questions.respond"])
const LONGEST_PAUSE_MS = 1200
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/

const notInRecording: RpcEnvelope<never> = {
  error: { tag: "Demo", message: "This is a recording of HinaCode. Download it to run your own agents." },
}

const locales: ReadonlyArray<Locale> = ["en", "zh-TW", "ja"]

const PAST_STRETCH = 40

function shiftTimes<T>(value: T, startedAt: number, offsetMs: number): T {
  const shift = (time: number) => (time < startedAt ? startedAt - (startedAt - time) * PAST_STRETCH : time) + offsetMs
  return JSON.parse(JSON.stringify(value), (_, field) =>
    typeof field === "string" && ISO_TIME.test(field) ? new Date(shift(Date.parse(field))).toISOString() : field,
  )
}

export async function replayBridge(params: URLSearchParams): Promise<HinacodeBridge> {
  const { default: recording } = (await import("./recording.json")) as { default: Recording }
  const { entries } = recording
  const locale = locales.find((candidate) => candidate === params.get("locale")) ?? "en"
  const desktop = desktopShim(locale)
  const listeners = new Set<(event: typeof PushEvent.Encoded) => void>()

  const triggers = entries.flatMap((entry, index) =>
    entry.kind === "call" && (AUTOPLAYED.has(entry.method) || WAITS_FOR_VISITOR.has(entry.method)) ? [index] : [],
  )
  const firstTrigger = triggers[0] ?? entries.length
  const startedAt = recording.recordedAt + (entries[firstTrigger]?.at ?? 0)
  const offsetMs = Date.now() - startedAt
  let cursor = firstTrigger - 1
  let playing = false

  const liveSend = entries.findLast(
    (entry): entry is RecordedCall => entry.kind === "call" && entry.method === "threads.send",
  )
  const threadId = (liveSend?.payload as { threadId?: string } | undefined)?.threadId
  for (const key of Object.keys(localStorage)) if (key.startsWith("hinacode.")) localStorage.removeItem(key)
  if (threadId) localStorage.setItem("hinacode.location", `/thread/${threadId}`)

  const emit = (entry: RecordedEvent) => {
    const event = shiftTimes(entry.event, startedAt, offsetMs)
    for (const listener of listeners) listener(event)
  }

  const play = async (from: number) => {
    playing = true
    const until = triggers.find(
      (index) => index > from && WAITS_FOR_VISITOR.has((entries[index] as RecordedCall).method),
    )
    let previousAt = entries[from]!.at
    for (let index = from; index < (until ?? entries.length); index++) {
      const entry = entries[index]!
      if (entry.kind !== "event") continue
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(Math.max(entry.at - previousAt, 0), LONGEST_PAUSE_MS)),
      )
      previousAt = entry.at
      cursor = index
      emit(entry)
    }
    cursor = (until ?? entries.length) - 1
    playing = false
  }

  const recorded = (method: string, payload: unknown) => {
    const key = JSON.stringify(payload ?? null)
    const matches = entries.flatMap((entry, index) =>
      entry.kind === "call" && entry.method === method && JSON.stringify(entry.payload ?? null) === key
        ? [{ entry, index }]
        : [],
    )
    return (matches.findLast(({ index }) => index <= cursor) ?? matches[0])?.entry
  }

  const start = () => {
    if (!playing && cursor < firstTrigger) void play(firstTrigger)
  }
  window.addEventListener("message", (message) => {
    if (message.origin === location.origin && message.data === PLAY_MESSAGE) start()
  })
  if (window.parent === window) setTimeout(start, 1500)

  return {
    rpc: async (method, payload) => {
      const local = desktop(method, payload)
      if (local) return local as never
      if (WAITS_FOR_VISITOR.has(method)) {
        const next = triggers.find((index) => index > cursor)
        if (next === undefined || playing) return notInRecording
        const entry = entries[next] as RecordedCall
        if (entry.method !== method) return notInRecording
        void play(next)
        return shiftTimes(entry.envelope, startedAt, offsetMs) as never
      }
      if (AUTOPLAYED.has(method)) return notInRecording
      const entry = recorded(method, payload)
      return (entry ? shiftTimes(entry.envelope, startedAt, offsetMs) : notInRecording) as never
    },
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    pathForFile: (file) => file.name,
    liquidGlass: false,
  }
}
