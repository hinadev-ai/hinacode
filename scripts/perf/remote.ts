import { mkdirSync, writeFileSync } from "node:fs"
import { cpus, loadavg } from "node:os"
import { dirname } from "node:path"
import { performance } from "node:perf_hooks"
import { deflateRawSync } from "node:zlib"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { compactMessage, compactPush, transcriptPage } from "../../src/shared/compactTranscript.ts"
import { PushEvent, RpcMethods, type RpcResponse } from "../../src/shared/contract.ts"
import type { Message } from "../../src/shared/domain.ts"
import { clientProof, serverProof } from "../../src/shared/proof.ts"
import { ClientFrame, ServerFrame } from "../../src/shared/remote.ts"
import * as Db from "../../src/main/db/client.ts"
import { seedThread } from "../../src/main/db/testing.ts"
import { Events, makeEventsLayer, PushBroadcast } from "../../src/main/services/Events.ts"
import * as Messages from "../../src/main/services/Messages.ts"

type Sample = { readonly medianMs: number; readonly minMs: number; readonly maxMs: number; readonly runs: number }
type Transcript = RpcResponse<"threads.transcript">
const samples = 9
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const summary = (times: number[]): Sample => {
  const sorted = times.toSorted((a, b) => a - b)
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)]!,
    minMs: sorted[0]!,
    maxMs: sorted.at(-1)!,
    runs: sorted.length,
  }
}
const measure = (f: () => unknown, runs = samples): Sample => {
  f()
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    f()
    times.push(performance.now() - start)
  }
  return summary(times)
}
const measureAsync = async (f: () => Promise<unknown>, runs = samples): Promise<Sample> => {
  await f()
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    await f()
    times.push(performance.now() - start)
  }
  return summary(times)
}

let state = 42
const words =
  "render scroll thread worktree sqlite effect electron renderer main process memory footprint virtual list markdown tool call diff patch commit branch const export interface return await string readonly command input output path token value file schema decode encode result message finished running".split(
    " ",
  )
const text = (bytes: number) => {
  const chunks: string[] = []
  let length = 0
  while (length < bytes) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const word = words[state % words.length]!
    chunks.push(word)
    length += word.length + 1
  }
  return chunks.join(" ").slice(0, bytes)
}
const output = text(64 * 1024)
const contents = text(12 * 1024)
const diff = text(8 * 1024)
const messagesFor = (threadId: string, count: number): Message[] =>
  Array.from({ length: count }, (_, index): Message => ({
    id: `${threadId}-message-${index}`,
    threadId,
    role: index % 2 === 0 ? "user" : "assistant",
    parts:
      index % 2 === 0
        ? [{ type: "text", text: text(280) }]
        : [
            { type: "text", text: text(1800) },
            {
              type: "tool_call",
              callId: `call-${index}`,
              name: "Write",
              input: { file_path: `src/file-${index}.ts`, content: contents },
              output,
              status: "done",
            },
            { type: "file_change", path: `src/file-${index}.ts`, diff },
          ],
    createdAt: "2026-10-29T00:00:00.000Z",
    completedAt: "2026-10-29T00:00:01.000Z",
    usage: null,
    forkPoint: null,
  }))

const pushes: PushEvent[] = []
for (let i = 0; i < 20; i++) {
  const base = { type: "thread.event", threadId: "remote-stream-thread", seq: pushes.length + 1 } satisfies Pick<
    Extract<PushEvent, { type: "thread.event" }>,
    "type" | "threadId" | "seq"
  >
  pushes.push({
    ...base,
    event: {
      type: "tool_call_started",
      callId: `call-${i}`,
      name: "Write",
      input: { file_path: `src/file-${i}.ts`, content: contents },
    },
  })
  pushes.push({
    ...base,
    seq: base.seq + 1,
    event: { type: "tool_call_finished", callId: `call-${i}`, output, isError: false },
  })
  pushes.push({ ...base, seq: base.seq + 2, event: { type: "file_changed", path: `src/file-${i}.ts`, diff } })
  for (let j = 0; j < 5; j++)
    pushes.push({ ...base, seq: base.seq + 3 + j, event: { type: "text_delta", text: text(48) } })
}

const encodeEvent = Schema.encodeSync(PushEvent)
const decodeFrame = Schema.decodeUnknownSync(ServerFrame)
const currentFrames = pushes.map((push) => JSON.stringify({ type: "event", event: encodeEvent(push) }))
const compactFrames = pushes.map((push) => JSON.stringify({ type: "event", event: compactPush(encodeEvent(push)) }))
for (const raw of [...currentFrames, ...compactFrames]) decodeFrame(JSON.parse(raw))
const liveSummary = (frames: readonly string[]) => ({
  frames: frames.length,
  rawBytes: frames.reduce((total, frame) => total + Buffer.byteLength(frame), 0),
  independentDeflateBytes: frames.reduce((total, frame) => total + deflateRawSync(frame).byteLength, 0),
  parseDecode: measure(() => frames.forEach((frame) => decodeFrame(JSON.parse(frame)))),
})
const fanout = async (clients: number) => {
  let compact = false
  const full: { bytes: number; frames: number; times: number[] } = { bytes: 0, frames: 0, times: [] }
  const projected: typeof full = { bytes: 0, frames: 0, times: [] }
  const program = Effect.gen(function* () {
    const broadcast = yield* PushBroadcast
    const events = yield* Events
    for (let i = 0; i < clients; i++) {
      yield* broadcast.subscribe((push) => {
        const raw = JSON.stringify({ type: "event", event: compact ? compactPush(push) : push })
        const counters = compact ? projected : full
        counters.bytes += Buffer.byteLength(raw)
        counters.frames++
      })
    }
    for (let run = 0; run < samples + 1; run++) {
      for (const mode of run % 2 === 0 ? [false, true] : [true, false]) {
        compact = mode
        const start = performance.now()
        for (const push of pushes) yield* events.publish(push)
        if (run > 0) (compact ? projected : full).times.push(performance.now() - start)
      }
    }
    return [full, projected].map((counters, index) => ({
      clients,
      compact: index === 1,
      bytesPerWorkload: counters.bytes / (samples + 1),
      framesPerWorkload: counters.frames / (samples + 1),
      ...summary(counters.times),
    }))
  }).pipe(Effect.scoped, Effect.provide(makeEventsLayer(() => {})))
  return Effect.runPromise(program)
}

const decodeTranscript = Schema.decodeUnknownSync(RpcMethods["threads.transcript"].response)
const encodeTranscript = Schema.encodeSync(RpcMethods["threads.transcript"].response)
const dbRuntime = ManagedRuntime.make(
  Messages.layer.pipe(Layer.provideMerge(Db.layer(":memory:")), Layer.provideMerge(NodeServices.layer)),
)
const histories = []
for (const count of [200, 2000]) {
  const threadId = await dbRuntime.runPromise(
    Effect.gen(function* () {
      const { threadId } = yield* seedThread({ rootPath: `/synthetic/remote-${count}` })
      const messages = yield* Messages.Messages
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(Effect.forEach(messagesFor(threadId, count), messages.insert, { discard: true }))
      return threadId
    }),
  )
  const read = () => dbRuntime.runPromise(Messages.Messages.use((messages) => messages.list(threadId)))
  const dbRead = await measureAsync(read, 7)
  globalThis.gc?.()
  const beforeHeap = process.memoryUsage().heapUsed
  const all = await read()
  globalThis.gc?.()
  const afterReadHeap = process.memoryUsage().heapUsed
  const compact = all.map(compactMessage)
  const page = transcriptPage(compact, undefined)
  const snapshot: Transcript = { ...page, seq: 0, approvals: [], questions: [], secretRequests: [] }
  const encoded = encodeTranscript(snapshot)
  const raw = JSON.stringify({ type: "result", id: 1, envelope: { result: encoded } })
  histories.push({
    messageCount: count,
    fullJsonBytes: size(all),
    compactJsonBytes: size(compact),
    pageMessageCount: page.messages.length,
    pageResultBytes: Buffer.byteLength(raw),
    retainedReadHeapBytes: afterReadHeap - beforeHeap,
    dbRead,
    compactAll: measure(() => all.map(compactMessage)),
    pageCompacted: measure(() => transcriptPage(compact, undefined)),
    encodePage: measure(() => encodeTranscript(snapshot)),
    stringifyPage: measure(() => JSON.stringify({ type: "result", id: 1, envelope: { result: encoded } })),
    parseDecodePage: measure(() => {
      const frame = decodeFrame(JSON.parse(raw))
      if (frame.type !== "result" || "error" in frame.envelope) throw new Error("Expected successful transcript result")
      decodeTranscript(frame.envelope.result)
    }),
    readCompactPageEncode: await measureAsync(async () => {
      const messages = await read()
      return JSON.stringify(
        encodeTranscript({
          ...transcriptPage(messages.map(compactMessage), undefined),
          seq: 0,
          approvals: [],
          questions: [],
          secretRequests: [],
        }),
      )
    }, 7),
  })
}
await dbRuntime.dispose()

const longText = messagesFor("oversize", 1)[0]!
const oversized: Message = { ...longText, parts: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }] }
const oversizedPage = transcriptPage([compactMessage(oversized)], undefined)
const nonceA = "a".repeat(64)
const nonceB = "b".repeat(64)
const token = "synthetic-pairing-token-never-a-user-secret"
const handshakeFrames = [
  { type: "challenge", nonce: nonceA } satisfies ServerFrame,
  { type: "auth", nonce: nonceB, proof: clientProof(token, nonceA, nonceB), compactEvents: true } satisfies ClientFrame,
  {
    type: "ready",
    version: 1,
    environment: { id: "synthetic", name: "Synthetic desktop" },
    features: ["heartbeat", "call-keys", "terminal-attach", "asks"],
    proof: serverProof(token, nonceB, nonceA),
  } satisfies ServerFrame,
]
const fanoutResults = []
for (const clients of [0, 1, 3]) fanoutResults.push(...(await fanout(clients)))
const result = {
  metadata: {
    kind: "synthetic data, actual schema/compaction/Events/Messages implementations",
    node: process.version,
    platform: process.platform,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    loadAverage: loadavg(),
    samples,
    gcExposed: globalThis.gc !== undefined,
    note: "In-memory SQLite includes production migrations and JSON row decoding. Full and compact fanout timings alternate. No app, production data, network, Hermes, TLS, relay, radio or React measurement. Independent deflate is a compression proxy without context takeover.",
  },
  histories,
  live: { current: liveSummary(currentFrames), compactActual: liveSummary(compactFrames), fanout: fanoutResults },
  handshake: {
    payloadBytes: handshakeFrames.map(size),
    combinedBytes: handshakeFrames.reduce((total, frame) => total + size(frame), 0),
    fourProofsPerHandshake1000Times: measure(() => {
      for (let i = 0; i < 1000; i++) {
        clientProof(token, nonceA, nonceB)
        serverProof(token, nonceB, nonceA)
        clientProof(token, nonceA, nonceB)
        serverProof(token, nonceB, nonceA)
      }
    }),
  },
  oversizedPage: { messageCount: oversizedPage.messages.length, jsonBytes: size(oversizedPage.messages) },
}
const reportPath = process.argv[2] ?? ".context/perf/remote.json"
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result, null, 2))
