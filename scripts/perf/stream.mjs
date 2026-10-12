#!/usr/bin/env node
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "../.."))
const resultsDir = join(root, ".context/perf")
const [rendererPort, inspectorPort, label, threadId] = process.argv.slice(2)
const data = process.env.KKCODE_USER_DATA
if (
  ![rendererPort, inspectorPort].every((port) => /^\d+$/.test(port ?? "") && +port > 0 && +port < 65536) ||
  !/^[\w-]+$/.test(label ?? "") ||
  !threadId ||
  !data?.startsWith("/tmp/kk-")
) {
  throw new Error(
    "usage: KKCODE_USER_DATA=/tmp/kk-<isolated-profile> [PARSE=1] [PROFILE=1] " +
      "node scripts/perf/stream.mjs <rendererCDP> <mainInspectorPort> <label> <threadId>",
  )
}
const profileEnabled = process.env.PROFILE === "1"
const parseEnabled = process.env.PARSE === "1"
const hash = (value) => createHash("sha256").update(value).digest("hex")
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stats = (values) => {
  const sorted = values.toSorted((a, b) => a - b)
  const q = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
  return {
    samples: values.length,
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: sorted.at(-1),
    over33: values.filter((value) => value > 33).length,
    over50: values.filter((value) => value > 50).length,
  }
}
const doctor = execFileSync(join(root, ".agents/skills/verify-kkcode/scripts/doctor.sh"), [rendererPort, data], {
  cwd: root,
  encoding: "utf8",
})

async function connect(port, type) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })
  assert(response.ok, `cannot list targets on ${port}`)
  const targets = (await response.json()).filter((target) => target.type === type)
  const expectedUrl = pathToFileURL(join(root, "out/renderer/index.html")).href
  const candidates = type === "page" ? targets.filter((target) => target.url === expectedUrl) : targets
  assert.equal(candidates.length, 1, `expected one ${type} target from this checkout on ${port}`)
  const target = candidates[0]
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`CDP connection timeout on ${port}`))
    }, 5000)
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    ws.addEventListener(
      "error",
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
      { once: true },
    )
  })
  let id = 0
  const pending = new Map()
  ws.addEventListener("message", ({ data: message }) => {
    const reply = JSON.parse(message)
    pending.get(reply.id)?.(reply)
  })
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id
      const timer = setTimeout(() => {
        pending.delete(key)
        reject(new Error(`${method} timed out`))
      }, 25000)
      pending.set(key, (reply) => {
        clearTimeout(timer)
        pending.delete(key)
        if (reply.error || reply.result?.exceptionDetails) reject(new Error(JSON.stringify(reply)))
        else resolve(reply.result)
      })
      ws.send(JSON.stringify({ id: key, method, params }))
    })
  return {
    target,
    call,
    close: () =>
      new Promise((resolve, reject) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve()
        const timer = setTimeout(() => reject(new Error(`CDP close timeout on ${port}`)), 5000)
        ws.addEventListener(
          "close",
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
        ws.close()
      }),
    eval: async (expression) =>
      (
        await call("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        })
      ).result?.value,
  }
}

const renderer = await connect(rendererPort, "page")
let main
let profiling = false
const runId = randomUUID()
try {
  main = await connect(inspectorPort, "node")
  const windowExpression = `process.getBuiltinModule('node:module').createRequire(process.cwd() + '/package.json')('electron').BrowserWindow.getAllWindows().filter(w => w.webContents.getURL() === ${JSON.stringify(renderer.target.url)})`
  const mainInfo = await main.eval(`(() => {
    const windows = ${windowExpression};
    return { cwd: process.cwd(), data: process.env.KKCODE_USER_DATA, pid: process.pid,
      windows: windows.map(w => ({ id: w.id, url: w.webContents.getURL() })) };
  })()`)
  assert.equal(realpathSync(mainInfo.cwd), root, "main inspector belongs to another checkout")
  assert.equal(mainInfo.data, data, "main inspector belongs to another profile")
  assert.equal(mainInfo.windows.length, 1, "main must own the selected renderer")
  assert.equal(await main.eval("Boolean(globalThis.__kkcodePerfStream?.timer)"), false, "another workload is active")
  await main.eval(`(() => { const w = (${windowExpression})[0]; w.show(); w.setAlwaysOnTop(true); w.focus(); })()`)

  await renderer.call("Page.enable")
  await renderer.eval("globalThis.__kkcodePerfReload = true")
  await renderer.call("Page.reload", { ignoreCache: true })
  const waitFor = async (expression, description) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      try {
        if (await renderer.eval(expression)) return
      } catch (error) {
        if (!/Execution context was destroyed|Cannot find context/.test(String(error))) throw error
      }
      await pause(50)
    }
    throw new Error(`timeout: ${description}`)
  }
  await waitFor(
    "!globalThis.__kkcodePerfReload && Boolean(window.kkcode && document.querySelector('main'))",
    "renderer reload",
  )
  const rpc = async (method, payload) => {
    const envelope = await renderer.eval(`window.kkcode.rpc(${JSON.stringify(method)}, ${JSON.stringify(payload)})`)
    assert(!envelope.error, JSON.stringify(envelope.error))
    return envelope.result
  }
  const thread = (await rpc("threads.list")).find((item) => item.id === threadId)
  assert(thread, "thread does not exist")
  const history = await rpc("threads.transcript", { threadId })
  assert(
    history.messages.every((message) => message.completedAt !== null),
    "thread has an unfinished persisted message",
  )
  assert.equal(history.approvals.length, 0, "thread has pending approvals")
  const linkSelector = `a[href=${JSON.stringify(`/thread/${threadId}`)}]`
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(linkSelector)}))`, "sidebar thread link")
  await renderer.eval(`document.querySelector(${JSON.stringify(linkSelector)}).click()`)
  const witness = history.messages
    .filter((message) => message.role === "user")
    .at(-1)
    ?.parts.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
  assert(
    history.messages.length === 0 || witness,
    "use an empty thread or a transcript with a visible final user message",
  )
  await waitFor(
    `(() => {
    const active = document.querySelector(${JSON.stringify(linkSelector)})?.getAttribute('data-status') === 'active';
    const title = document.querySelector('main header h1')?.textContent === ${JSON.stringify(thread.title)};
    const loaded = ${
      history.messages.length === 0
        ? "document.querySelector('main h2') && !document.querySelector('main article')"
        : `[...document.querySelectorAll('main article[aria-label]')].some(el => el.textContent.trim() === ${JSON.stringify(witness.trim())})`
    };
    return active && title && loaded;
  })()`,
    "selected thread and loaded persisted transcript",
  )

  const marker = await renderer.eval(
    "globalThis.__kkcodePerfMarkdown && { ...globalThis.__kkcodePerfMarkdown, samples: null }",
  )
  let instrumentation = null
  if (parseEnabled) {
    assert.equal(
      marker?.version,
      1,
      "parse instrumentation absent; run python3 scripts/perf/instrument-bundle.py after pnpm build, then reload; pnpm build restores it",
    )
    instrumentation = JSON.parse(readFileSync(join(resultsDir, "instrumentation.json"), "utf8"))
    assert.equal(
      marker.originalSha256,
      instrumentation.originalSha256,
      "loaded instrumentation is stale; rebuild, instrument, reload",
    )
    assert.equal(marker.bundle, instrumentation.bundle)
    assert.equal(
      hash(readFileSync(join(root, instrumentation.bundle))),
      instrumentation.instrumentedSha256,
      "instrumented bundle changed",
    )
  }
  const block =
    "# Streaming report\n\nParagraph with **bold**, *italic*, `inline code`, and [link](https://example.com).\n\n- First list item\n- Second item with ~~strike~~\n\n| Name | Value |\n| --- | --- |\n| alpha | 123 |\n| beta | 456 |\n\n```typescript\nconst value = 42\nconsole.log(value)\n```\n\n> A quote with **emphasis**.\n\n"
  const text = block.repeat(Math.ceil(20000 / block.length)).slice(0, 20000)
  const workload = {
    sha256: hash(text),
    text,
    chars: text.length,
    deltas: 160,
    charsPerDelta: 125,
    intervalMs: 20,
    settlingMs: 1000,
  }
  await renderer.eval(`(() => {
    const state = globalThis.__kkcodePerfFrames = { gaps: [], longTasks: [], events: [], hidden: false, active: true };
    state.observer = new PerformanceObserver(list => state.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration }))));
    state.observer.observe({ type: 'longtask', buffered: false });
    state.visibilityListener = () => { state.hidden ||= document.visibilityState !== 'visible'; };
    document.addEventListener('visibilitychange', state.visibilityListener);
    state.off = window.kkcode.onEvent(push => {
      if (push.message?.threadId === ${JSON.stringify(threadId)} || push.threadId === ${JSON.stringify(threadId)}) state.events.push(push);
    });
    const tick = () => {
      if (!state.active) return;
      const now = performance.now();
      if (state.last !== undefined) state.gaps.push(now - state.last);
      state.last = now;
      state.hidden ||= document.visibilityState !== 'visible';
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
  })()`)
  await pause(1000)
  const idle = await renderer.eval(`({ frames: __kkcodePerfFrames.gaps, hidden: __kkcodePerfFrames.hidden,
    visibility: document.visibilityState, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } })`)
  assert.equal(idle.visibility, "visible", "renderer must be visible")
  assert.equal(idle.hidden, false, "renderer was hidden during idle sampling")
  assert(idle.frames.length >= 30, "fewer than 30 idle frames; fix window visibility/throttling")
  const currentHistory = await rpc("threads.transcript", { threadId })
  assert.equal(
    hash(JSON.stringify(currentHistory.messages)),
    hash(JSON.stringify(history.messages)),
    "transcript changed while preparing",
  )
  assert.equal(
    await renderer.eval("__kkcodePerfFrames.events.length"),
    0,
    "thread received live events while preparing",
  )
  await renderer.eval(`__kkcodePerfFrames.gaps = []; __kkcodePerfFrames.longTasks = []; __kkcodePerfFrames.last = undefined;
    if (globalThis.__kkcodePerfMarkdown) __kkcodePerfMarkdown.samples = ${parseEnabled ? "[]" : "null"};`)
  if (profileEnabled) {
    await renderer.call("Profiler.enable")
    await renderer.call("Profiler.setSamplingInterval", { interval: 200 })
    await renderer.call("Profiler.start")
    profiling = true
  }
  const message = {
    id: `perf-${runId}`,
    threadId,
    role: "assistant",
    parts: [],
    createdAt: new Date().toISOString(),
    completedAt: null,
    usage: null,
  }
  await main.eval(`(() => {
    const w = (${windowExpression})[0];
    const text = ${JSON.stringify(text)};
    const state = globalThis.__kkcodePerfStream = { runId: ${JSON.stringify(runId)}, done: false, deltas: 0, emittedAtMs: [], start: performance.now() };
    let seq = ${currentHistory.seq};
    w.webContents.send('event', { type: 'message.created', seq: ++seq, message: ${JSON.stringify(message)} });
    state.timer = setInterval(() => {
      try {
        const offset = state.deltas * 125;
        w.webContents.send('event', { type: 'thread.event', seq: ++seq, threadId: ${JSON.stringify(threadId)}, event: { type: 'text_delta', text: text.slice(offset, offset + 125) } });
        state.emittedAtMs.push(performance.now() - state.start);
        if (++state.deltas === 160) {
          clearInterval(state.timer); state.timer = null;
          w.webContents.send('event', { type: 'thread.event', seq: ++seq, threadId: ${JSON.stringify(threadId)}, event: { type: 'turn_completed' } });
          state.emitMs = performance.now() - state.start; state.done = true;
        }
      } catch (error) { clearInterval(state.timer); state.timer = null; state.error = String(error); state.done = true; }
    }, 20);
  })()`)
  let timing
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    timing = await main.eval("({ ...globalThis.__kkcodePerfStream, timer: undefined })")
    if (timing.done) break
    await pause(100)
  }
  assert(timing?.done && !timing.error, `main workload failed: ${JSON.stringify(timing)}`)
  await pause(workload.settlingMs)
  await waitFor(
    `(() => {
    const el = [...document.querySelectorAll('main article')].at(-1);
    return el?.getAttribute('aria-busy') === 'false' && el.querySelectorAll('h1').length === ${(text.match(/^# Streaming report/gm) ?? []).length};
  })()`,
    "completed message and final Markdown headings",
  )
  const raw = await renderer.eval(`(() => {
    const state = __kkcodePerfFrames;
    state.active = false; cancelAnimationFrame(state.raf); state.observer.disconnect(); state.off(); document.removeEventListener('visibilitychange', state.visibilityListener);
    const el = [...document.querySelectorAll('main article')].at(-1);
    return { frames: state.gaps, longTasks: state.longTasks, events: state.events, hidden: state.hidden,
      visibility: document.visibilityState, parses: globalThis.__kkcodePerfMarkdown?.samples ?? null,
      dom: { html: el.innerHTML, text: el.textContent, busy: el.getAttribute('aria-busy'),
        headings: el.querySelectorAll('h1').length, tables: el.querySelectorAll('table').length, codeBlocks: el.querySelectorAll('pre').length } };
  })()`)
  assert.equal(raw.visibility, "visible")
  assert.equal(raw.hidden, false, "renderer was hidden during streaming")
  assert(raw.frames.length >= 30, "insufficient streaming frames")
  assert.equal(raw.events.length, 162, "expected message.created, 160 deltas and turn_completed only")
  assert.equal(raw.events[0].message?.id, message.id)
  assert.equal(raw.events.at(-1).event?.type, "turn_completed")
  raw.events.forEach((event, index) => assert.equal(event.seq, currentHistory.seq + index + 1))
  assert(
    raw.events.slice(1, -1).every((event) => event.event?.type === "text_delta" && event.event.text.length === 125),
  )
  assert.equal(
    raw.events
      .slice(1, -1)
      .map((event) => event.event.text)
      .join(""),
    text,
  )
  assert.equal(raw.dom.tables, Math.floor(text.length / block.length), "final tables missing")
  assert.equal(raw.dom.codeBlocks, Math.floor(text.length / block.length), "final code blocks missing")
  const finalHistory = await rpc("threads.transcript", { threadId })
  assert.equal(
    hash(JSON.stringify(finalHistory.messages)),
    hash(JSON.stringify(history.messages)),
    "persisted transcript changed during workload",
  )
  if (parseEnabled) {
    assert(raw.parses?.length > 0, "instrumentation recorded no parses; zero is not valid parse evidence")
    assert(
      raw.parses.some((parse) => parse.chars === text.length),
      "instrumentation never parsed the final text",
    )
  }
  const result = {
    label,
    scenario: "stream",
    at: new Date().toISOString(),
    threadId,
    runId,
    checkout: root,
    main: mainInfo,
    renderer: renderer.target.url,
    doctor,
    profileEnabled,
    parseEnabled,
    instrumented: marker?.version === 1,
    instrumentation,
    workload,
    history: {
      messages: history.messages.length,
      sha256: hash(JSON.stringify(history.messages)),
      seq: currentHistory.seq,
      witness: witness ?? null,
    },
    idle: { ...stats(idle.frames), visibility: idle.visibility, hidden: idle.hidden },
    viewport: idle.viewport,
    stream: stats(raw.frames),
    timing,
    parsing: parseEnabled
      ? {
          count: raw.parses.length,
          totalMs: raw.parses.reduce((sum, parse) => sum + parse.ms, 0),
          chars: raw.parses.reduce((sum, parse) => sum + parse.chars, 0),
          maxMs: Math.max(...raw.parses.map((parse) => parse.ms)),
        }
      : null,
    longTaskMs: raw.longTasks.reduce((sum, task) => sum + task.ms, 0),
    domSha256: hash(raw.dom.text),
    raw: { ...raw, idleFrames: idle.frames },
  }
  mkdirSync(resultsDir, { recursive: true })
  if (profiling) {
    const { profile } = await renderer.call("Profiler.stop")
    profiling = false
    writeFileSync(join(resultsDir, `${label}-stream.cpuprofile`), JSON.stringify(profile))
  }
  const file = join(resultsDir, `${label}-stream.json`)
  writeFileSync(file, JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify(
      { file, idle: result.idle, stream: result.stream, parsing: result.parsing, emitMs: timing.emitMs },
      null,
      2,
    ),
  )
} finally {
  if (profiling) await renderer.call("Profiler.stop").catch(() => {})
  await renderer
    .eval(`if (globalThis.__kkcodePerfFrames) {
    const state = __kkcodePerfFrames; state.active = false; cancelAnimationFrame(state.raf); state.observer.disconnect(); state.off(); document.removeEventListener('visibilitychange', state.visibilityListener);
  } if (globalThis.__kkcodePerfMarkdown) __kkcodePerfMarkdown.samples = null;`)
    .catch(() => {})
  if (main) {
    await main
      .eval(`if (globalThis.__kkcodePerfStream?.runId === ${JSON.stringify(runId)}) {
      clearInterval(__kkcodePerfStream.timer); __kkcodePerfStream.timer = null;
    }`)
      .catch(() => {})
  }
  await Promise.all([renderer.close(), ...(main ? [main.close()] : [])])
}
