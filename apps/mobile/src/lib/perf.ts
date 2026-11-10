/**
 * The phone side of `scripts/perf/mobile.ts`. Only a release bundle built with `EXPO_PUBLIC_PERF_URL` contains it:
 * metro.config.js loads it through `perf-renderer.js`, just before React's profiling renderer. It long-polls the
 * driver for a workload, runs it and posts back what it saw: commits with the components each rendered and their
 * render time, JS frame gaps, and long tasks.
 *
 * The stores and the router load lazily, after the first commit, so this module does not change the app's
 * startup order.
 */

type Fiber = {
  tag: number
  type: unknown
  elementType: unknown
  flags: number
  child: Fiber | null
  sibling: Fiber | null
  alternate: Fiber | null
  memoizedProps: Record<string, unknown> | null
  stateNode: unknown
  actualDuration?: number
}
type FiberRoot = { current: Fiber }
type Commit = { at: number; renderMs: number | null; rendered: Record<string, number> }
type Command = { id: number; type: string; [key: string]: unknown }

const url = process.env.EXPO_PUBLIC_PERF_URL ?? ""

const FUNCTION = 0
const CLASS = 1
const FORWARD_REF = 11
const MEMO = 14
const SIMPLE_MEMO = 15
const PERFORMED_WORK = 1
const composite = new Set([FUNCTION, CLASS, FORWARD_REF, MEMO, SIMPLE_MEMO])

const nameOf = (fiber: Fiber) => {
  const type = fiber.type as { displayName?: string; name?: string; type?: unknown; render?: unknown } | null
  const inner = (fiber.tag === MEMO ? type?.type : fiber.tag === FORWARD_REF ? type?.render : type) as
    | { displayName?: string; name?: string }
    | undefined
  return type?.displayName || inner?.displayName || inner?.name || "Anonymous"
}

/** Components that rendered in this commit: every new fiber, and every old one that did work. */
function walk(next: Fiber, prev: Fiber | null, rendered: Record<string, number>) {
  if (composite.has(next.tag) && (prev === null || (next.flags & PERFORMED_WORK) !== 0)) {
    const name = prev === null ? `${nameOf(next)} (mount)` : nameOf(next)
    rendered[name] = (rendered[name] ?? 0) + 1
  }
  if (prev !== null && next.child === prev.child) return
  for (let child = next.child; child !== null; child = child.sibling) walk(child, child.alternate, rendered)
}

const roots = new Set<FiberRoot>()
let commits: Commit[] = []
let recording = false
const commitWaiters: (() => void)[] = []

function onCommit(root: FiberRoot) {
  roots.add(root)
  if (recording) {
    const rendered: Record<string, number> = {}
    walk(root.current, root.current.alternate, rendered)
    // Only the profiling renderer, which metro.config.js picks for perf bundles, times renders.
    const renderMs = root.current.actualDuration ?? null
    commits.push({ at: performance.now(), renderMs, rendered })
  }
  for (const resolve of commitWaiters.splice(0)) resolve()
}

function installHook() {
  let nextId = 1
  ;(globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    inject() {
      return nextId++
    },
    onCommitFiberRoot(_id: number, root: FiberRoot) {
      onCommit(root)
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  }
}

const nextCommit = () => new Promise<void>((resolve) => commitWaiters.push(resolve))
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(() => resolve(performance.now())))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolves once no commit has landed for `quietMs`, with the time of the last one. */
async function settle(quietMs: number, timeoutMs = 15000) {
  const start = performance.now()
  for (;;) {
    const last = commits.at(-1)?.at ?? start
    const now = performance.now()
    if (now - last >= quietMs || now - start > timeoutMs) return last
    await sleep(50)
  }
}

let frames: number[] = []
let longTasks: { start: number; duration: number }[] = []
let frameLoopId = 0

/** One frame callback chain per recording, so a recording that starts before the last chain ends is not counted twice. */
function frameLoop(id: number) {
  if (!recording || id !== frameLoopId) return
  frames.push(performance.now())
  requestAnimationFrame(() => frameLoop(id))
}

function observeLongTasks() {
  const Observer = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver
  if (Observer === undefined || !Observer.supportedEntryTypes?.includes("longtask")) return false
  new Observer((list) => {
    if (!recording) return
    for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration })
  }).observe({ type: "longtask" })
  return true
}

function startRecording() {
  commits = []
  frames = []
  longTasks = []
  recording = true
  const id = ++frameLoopId
  requestAnimationFrame(() => frameLoop(id))
}

function stopRecording() {
  recording = false
  return { commits, frames, longTasks }
}

function findFiber(match: (fiber: Fiber) => boolean): Fiber | undefined {
  const stack = [...roots].map((root) => root.current)
  while (stack.length > 0) {
    const fiber = stack.pop()!
    if (match(fiber)) return fiber
    for (let child = fiber.child; child !== null; child = child.sibling) stack.push(child)
  }
  return undefined
}

const withTestID = (testID: string) => (fiber: Fiber) => fiber.memoizedProps?.testID === testID

type Store<S> = { getState: () => S; subscribe: (listener: (state: S) => void) => () => void }

/**
 * When `store` first satisfies `ready`, and when the commit that follows it reaches the next frame. The check runs
 * inside the store's update, before React renders it, so that commit cannot slip past.
 */
function paintedWhen<S>(store: Store<S>, ready: (state: S) => boolean, timeoutMs = 60000) {
  return new Promise<{ readyAt: number; paintedAt: number }>((resolve, reject) => {
    const timer = setTimeout(() => (unsubscribe(), reject(new Error("timed out"))), timeoutMs)
    const finish = (committed: Promise<void> | null) => {
      const readyAt = performance.now()
      clearTimeout(timer)
      unsubscribe()
      void (committed ?? Promise.resolve()).then(nextFrame).then((paintedAt) => resolve({ readyAt, paintedAt }))
    }
    const unsubscribe = store.subscribe((state) => {
      if (ready(state)) finish(nextCommit())
    })
    if (ready(store.getState())) finish(null)
  })
}

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after startup on purpose, see the header */
const stores = () => ({
  threads: (require("@/stores/threads") as typeof import("@/stores/threads")).useThreads,
  messages: (require("@/stores/messages") as typeof import("@/stores/messages")).useMessages,
})
const router = () => (require("expo-router") as typeof import("expo-router")).router
const connection = () => require("@/lib/connection") as typeof import("@/lib/connection")
const parseDocument = () =>
  (require("@shared/document/parse.ts") as typeof import("@shared/document/parse.ts")).parseDocument
const perfFrames = () => (require("@hinacode/perf-frames") as typeof import("@hinacode/perf-frames")).loadPerfFrames()
/* eslint-enable @typescript-eslint/no-require-imports */

let firstCommit: number | null = null

/** React Native's startup marks, read one by one because the object's fields are getters JSON does not see. */
function startupTiming() {
  const timing = (performance as { rnStartupTiming?: Record<string, number | undefined> }).rnStartupTiming
  if (timing === undefined) return null
  const { startTime, initializeRuntimeStart, executeJavaScriptBundleEntryPointStart, endTime } = timing
  return { startTime, initializeRuntimeStart, executeJavaScriptBundleEntryPointStart, endTime }
}
let longTasksObserved = false
let threadList: Promise<{ readyAt: number; paintedAt: number }> | null = null

/** Startup timings, and the thread list's first paint once the desktop has answered. */
async function hello() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadServers } = require("@/lib/storage") as typeof import("@/lib/storage")
  const paired = (await loadServers()).length > 0
  const threadListPainted = paired ? ((await threadList)?.paintedAt ?? null) : null
  return {
    paired,
    longTasksObserved,
    // `performance.now()` counts from boot without the time the Mac slept, so convert with the wall clock instead.
    epochOffset: Date.now() - performance.now(),
    startup: startupTiming(),
    firstCommit,
    threadListPainted,
  }
}

/** Pairs with the target the driver read from the desktop, as scanning its QR code would. */
async function pair(command: Command) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { pair } = require("@/components/connection-provider") as typeof import("@/components/connection-provider")
  await pair(command.target as Parameters<typeof pair>[0])
  return {}
}

/** Opens a thread from the list with its transcript not loaded yet, as the first visit does. */
async function open(command: Command) {
  const threadId = String(command.threadId)
  const { messages } = stores()
  messages.getState().reset()
  startRecording()
  const start = performance.now()
  const shown = paintedWhen(messages, (state) => state.byThread[threadId]?.status === "ready")
  router().push({ pathname: "/thread/[id]", params: { id: threadId } })
  const { readyAt: loaded, paintedAt: painted } = await shown
  const settled = await settle(1000)
  return { start, loaded, painted, settled, ...stopRecording() }
}

async function back() {
  router().back()
  await settle(500)
  return {}
}

/** Scrolls a list by `px` every frame, as `scroll` does on the desktop. JS drives it, so it measures JS cost only. */
async function scroll(command: Command) {
  const list = findFiber((fiber) => withTestID(String(command.testID))(fiber) && hasScrollTo(fiber.stateNode))
  if (list === undefined) throw new Error(`no list with testID ${command.testID}`)
  const instance = list.stateNode as { scrollToOffset: (options: { offset: number; animated: boolean }) => void }
  const px = Number(command.px ?? 40)
  const steps = Number(command.frames ?? 180)
  instance.scrollToOffset({ offset: 0, animated: false })
  await settle(300)
  startRecording()
  const start = performance.now()
  for (let step = 1; step <= steps; step++) {
    instance.scrollToOffset({ offset: step * px, animated: false })
    await nextFrame()
  }
  const end = performance.now()
  await settle(300)
  const result = { start, end, ...stopRecording() }
  instance.scrollToOffset({ offset: 0, animated: false })
  await settle(300)
  return result
}

const hasScrollTo = (node: unknown) =>
  typeof node === "object" && node !== null && typeof (node as { scrollToOffset?: unknown }).scrollToOffset === "function"

/**
 * Calls the composer's `onChangeText` one character at a time. Native text input is not part of it, and the update
 * runs at React's default priority instead of a key press's discrete one.
 */
async function type(command: Command) {
  // Read the handler again for each key: the composer makes a new one every render.
  const change = (next: string) => {
    const input = findFiber(
      (fiber) => withTestID("composer-input")(fiber) && typeof fiber.memoizedProps?.onChangeText === "function",
    )
    if (input === undefined) throw new Error("no composer")
    return () => (input.memoizedProps!.onChangeText as (text: string) => void)(next)
  }
  const text = String(command.text)
  const intervalMs = Number(command.intervalMs ?? 50)
  const keys: { at: number; commit: number | null; paint: number }[] = []
  // The transcript may still be mounting batches after a scroll; let it finish so only keys are measured.
  await settle(1000)
  startRecording()
  for (let length = 1; length <= text.length; length++) {
    const press = change(text.slice(0, length))
    const committed = nextCommit().then(() => performance.now())
    const at = performance.now()
    press()
    const commit = await Promise.race([committed, sleep(1000).then(() => null)])
    keys.push({ at, commit, paint: await nextFrame() })
    await sleep(intervalMs)
  }
  const result = { keys, ...stopRecording() }
  change("")()
  await settle(300)
  return result
}

/** Records while the driver sends a prompt to the desktop's paced mock reply, until that reply completes. */
async function reply(command: Command) {
  const threadId = String(command.threadId)
  const { messages } = stores()
  const before = messages.getState().byThread[threadId]
  const known = new Set(before?.status === "ready" ? before.messages.map((message) => message.id) : [])
  const finished = paintedWhen(messages, (state) => {
    const history = state.byThread[threadId]
    return (
      history?.status === "ready" &&
      history.messages.some((message) => !known.has(message.id) && message.role === "assistant" && message.completedAt)
    )
  })
  startRecording()
  const start = performance.now()
  await post("/ready", { id: command.id })
  const { readyAt: done, paintedAt: painted } = await finished
  const settled = await settle(1000)
  return { start, done, painted, settled, ...stopRecording() }
}

function hermesHeap() {
  const stats = (
    globalThis as { HermesInternal?: { getInstrumentedStats?: () => Record<string, number> } }
  ).HermesInternal?.getInstrumentedStats?.()
  return stats === undefined ? null : { heapSize: stats.js_heapSize, allocatedBytes: stats.js_allocatedBytes }
}

type NativeDocument = {
  applyPatch: (patch: string) => Promise<void>
  scrollToBlock: (index: number) => Promise<void>
}

const isNativeDocument = (node: unknown): node is NativeDocument =>
  typeof node === "object" && node !== null && typeof (node as { applyPatch?: unknown }).applyPatch === "function"

const appliedPatches: number[] = []
const patchWaiters: (() => void)[] = []
const probed = new WeakSet<object>()

/** Records when each patch the document view receives has been applied natively, as the next frame after it. */
function probeNativeDocument() {
  const fiber = findFiber((candidate) => isNativeDocument(candidate.stateNode))
  const view = fiber?.stateNode
  if (!isNativeDocument(view)) return null
  if (probed.has(view)) return view
  probed.add(view)
  const apply = view.applyPatch.bind(view)
  view.applyPatch = async (patch) => {
    await apply(patch)
    appliedPatches.push(await nextFrame())
    for (const resolve of patchWaiters.splice(0)) resolve()
  }
  return view
}

const nextPatch = () => new Promise<void>((resolve) => patchWaiters.push(resolve))

/** Resolves once no commit and no native patch has landed for `quietMs`, with the time of the last one. */
async function settleWithPatches(quietMs: number, timeoutMs = 15000) {
  const start = performance.now()
  for (;;) {
    const last = Math.max(commits.at(-1)?.at ?? start, appliedPatches.at(-1) ?? start)
    const now = performance.now()
    if (now - last >= quietMs || now - start > timeoutMs) return last
    await sleep(50)
  }
}

/**
 * Opens a document and times its first content: the frame after the first patch the native view applied, or for
 * a JS-rendered screen the frame after the commit that mounted it. Afterwards, outside the recording, it times
 * `parseDocument` on the same Markdown, the JS parse the screen runs.
 */
async function openDocument(command: Command) {
  const threadId = String(command.threadId)
  const artifactId = String(command.artifactId)
  await settle(300)
  appliedPatches.length = 0
  startRecording()
  const start = performance.now()
  const mounted = (async () => {
    for (;;) {
      await nextCommit()
      if (findFiber(withTestID("document")) === undefined) continue
      const native = probeNativeDocument()
      if (native === null) return nextFrame()
      if (appliedPatches.length === 0) await nextPatch()
      return appliedPatches[0]!
    }
  })()
  router().push({ pathname: "/thread/[id]/document", params: { id: threadId, artifactId, title: "perf" } })
  const firstContent = await mounted
  const settled = await settleWithPatches(1000)
  const heap = hermesHeap()
  const recorded = stopRecording()
  const { markdown } = await connection().call("artifacts.readDocument", { id: artifactId })
  const parse = parseDocument()
  const parseStart = performance.now()
  const blocks = parse(markdown).doc.childCount
  const parseMs = performance.now() - parseStart
  const patches = appliedPatches.slice()
  return { start, firstContent, settled, patches, heap, parseMs, blocks, bytes: markdown.length, ...recorded }
}

/** Samples native frames while the driver injects swipes. The driver answers `/ready` once the last one is done. */
async function fling(command: Command) {
  const sampler = perfFrames()
  await settle(500)
  startRecording()
  await sampler.start()
  const start = performance.now()
  await post("/ready", { id: command.id })
  const nativeFrames = await sampler.stop()
  const end = performance.now()
  await settle(500)
  return { start, end, nativeFrames, ...stopRecording() }
}

/** Waits for the open document's `artifact.updated` push while the driver saves it, then times the repaint. */
async function updateDocument(command: Command) {
  const artifactId = String(command.artifactId)
  const native = probeNativeDocument()
  if (native === null) throw new Error("no open document")
  await native.scrollToBlock(0)
  await settle(1000)
  let unsubscribe = () => {}
  const arrived = new Promise<number>((resolve) => {
    unsubscribe = connection().onEvent((event) => {
      if (event.type === "artifact.updated" && event.artifact.id === artifactId) resolve(performance.now())
    })
  })
  appliedPatches.length = 0
  startRecording()
  const start = performance.now()
  const patched = nextPatch()
  await post("/ready", { id: command.id })
  const eventAt = await Promise.race([arrived, sleep(20000).then(() => null)])
  unsubscribe()
  if (eventAt === null) throw new Error("no artifact.updated within 20 s")
  await Promise.race([patched, sleep(10000)])
  const paintedAt = appliedPatches.find((at) => at > eventAt) ?? null
  const settled = await settleWithPatches(1000)
  const recorded = stopRecording()
  return { start, eventAt, settled, paintedAt, ...recorded }
}

const workloads: Record<string, (command: Command) => Promise<unknown>> = {
  hello,
  pair,
  open,
  back,
  scroll,
  type,
  reply,
  openDocument,
  fling,
  updateDocument,
}

async function post(path: string, body: unknown) {
  await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
}

async function serve() {
  for (;;) {
    let command: Command | null = null
    try {
      const response = await fetch(`${url}/next`)
      if (response.status === 200) command = (await response.json()) as Command
    } catch {
      await sleep(1000)
    }
    if (command === null) continue
    const run = workloads[command.type]
    try {
      if (run === undefined) throw new Error(`unknown workload ${command.type}`)
      await post("/result", { id: command.id, ok: true, result: await run(command) })
    } catch (cause) {
      recording = false
      await post("/result", { id: command.id, ok: false, error: String(cause) }).catch(() => {})
    }
  }
}

installHook()
longTasksObserved = observeLongTasks()
commitWaiters.push(() => {
  firstCommit = performance.now()
  const { threads } = stores()
  threadList = paintedWhen(threads, (state) => state.status === "ready" && state.projects.length > 0)
  void post("/hello", {}).catch(() => {})
  void serve()
})
