import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { BrowserCommand } from "../../shared/browser.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import * as Attachments from "./Attachments.ts"
import { Browser, browserLayer, type BrowserOptions } from "./Browser.ts"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

const page = `<!doctype html><html><head><title>Remote browser</title></head>
<body style="margin:0;height:2000px;background:white">
<input id="entry" aria-label="Text" style="position:absolute;left:20px;top:20px;width:220px;height:40px" oninput="document.title=this.value">
<button id="counter" style="position:absolute;left:20px;top:80px;width:160px;height:40px" onclick="document.title='Clicked'">Click</button>
<button id="target" style="position:absolute;left:20px;top:140px;width:160px;height:40px">Pick target</button>
<a id="next" href="/second" style="position:absolute;left:20px;top:220px">Second page</a>
<a href="/second" target="_blank" style="position:absolute;left:20px;top:260px">Popup</a>
<button style="position:absolute;left:20px;top:300px" onclick="const popup=window.open('about:blank'); popup.location='/second'">Blank popup</button>
<form action="/result" method="POST" target="_blank" style="position:absolute;left:20px;top:350px"><input type="hidden" name="nonce" value="remote"><button>Submit popup</button></form>
<button style="position:absolute;left:20px;top:400px" onclick="const popup=window.open('about:blank'); fetch('/popup-content').then(r=>r.text()).then(html=>{popup.document.write(html); popup.document.close()})">Write popup</button>
<script>
addEventListener('keydown',e=>fetch('/events?type=keydown&key='+encodeURIComponent(e.key)))
addEventListener('keyup',e=>fetch('/events?type=keyup&key='+encodeURIComponent(e.key)))
addEventListener('resize',()=>fetch('/events?type=resize&width='+innerWidth+'&height='+innerHeight))
addEventListener('scroll',()=>fetch('/events?type=scroll&y='+scrollY))
</script></body></html>`

const fixture = async (options: BrowserOptions = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "hinacode-browser-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const events: Array<URL> = []
  const requests: Array<{ method: string; path: string; body: string }> = []
  let deliverPopup: (() => void) | null = null
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const recorded = { method: request.method ?? "GET", path: url.pathname, body: "" }
    requests.push(recorded)
    if (url.pathname === "/popup-content") {
      deliverPopup = () => {
        response.end("<title>Written popup</title><button id=written>Written</button>")
      }
      return
    }
    request.on("data", (data: Buffer) => {
      recorded.body += data.toString()
    })
    if (url.pathname === "/result") {
      request.on("end", () => {
        response.setHeader("content-type", "text/html")
        response.end(`<!doctype html><title>${recorded.method} ${recorded.body}</title>
          <input id="adopted-input" style="position:absolute;left:20px;top:20px;width:220px;height:40px" oninput="document.title=this.value">
          <button id="adopted-target" style="position:absolute;left:20px;top:100px;width:160px;height:40px">Adopted target</button>`)
      })
      return
    }
    if (url.pathname === "/hang") return
    if (url.pathname === "/events") {
      events.push(url)
      response.writeHead(204).end()
      return
    }
    if (url.pathname === "/redirect-file") {
      response.writeHead(302, { location: "file:///etc/passwd" }).end()
      return
    }
    if (url.pathname === "/set-cookie") response.setHeader("set-cookie", "session=thread-a; Path=/")
    response.setHeader("content-type", "text/html")
    if (url.pathname === "/cookie") {
      response.end("<!doctype html><title>Cookies</title><script>document.title=document.cookie || 'empty'</script>")
      return
    }
    response.end(url.pathname === "/second" ? "<!doctype html><title>Second page</title><h1>Second</h1>" : page)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("HTTP fixture has no TCP port")
  const origin = `http://127.0.0.1:${address.port}`
  const runtime = ManagedRuntime.make(
    browserLayer(options).pipe(
      Layer.provideMerge(Layer.merge(Db.layer(":memory:"), Attachments.layer(join(directory, "attachments")))),
    ),
  )
  cleanups.push(() => runtime.dispose())
  const [first, second] = await runtime.runPromise(
    Effect.all([seedThread({ rootPath: directory }), seedThread({ rootPath: join(directory, "second") })]),
  )
  const browser = await runtime.runPromise(Browser)
  const open = async (threadId = first.threadId, path = "/") => {
    const { sessionId } = await runtime.runPromise(
      browser.open({ threadId, url: `${origin}${path}`, width: 800, height: 600 }),
    )
    const session = { threadId, sessionId }
    return {
      ...session,
      send: (command: BrowserCommand) => runtime.runPromise(browser.command({ ...session, commands: [command] })),
      batch: (commands: ReadonlyArray<BrowserCommand>) => runtime.runPromise(browser.command({ ...session, commands })),
      snapshot: (after = 0, visible = true) => runtime.runPromise(browser.frame({ ...session, after, visible })),
      close: () => runtime.runPromise(browser.close(session)),
    }
  }
  return {
    runtime,
    browser,
    origin,
    first,
    second,
    events,
    requests,
    open,
    deliverPopup: () => {
      if (deliverPopup === null) throw new Error("Popup has not requested its document")
      deliverPopup()
    },
  }
}

const pointer = (
  type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel",
  x: number,
  y: number,
): Extract<BrowserCommand, { kind: "pointer" }> => ({
  kind: "pointer",
  type,
  x,
  y,
  button: type === "mouseMoved" || type === "mouseWheel" ? "none" : "left",
  buttons: type === "mousePressed" ? 1 : 0,
  clickCount: type === "mouseMoved" || type === "mouseWheel" ? 0 : 1,
  modifiers: 0,
  deltaX: 0,
  deltaY: type === "mouseWheel" ? 300 : 0,
})

const shortcut = (code: string, key: string, keyCode: number, modifiers = 4): BrowserCommand[] => [
  { kind: "key", type: "keyDown", code, key, keyCode, modifiers, text: "" },
  { kind: "key", type: "keyUp", code, key, keyCode, modifiers, text: "" },
]

describe("host browser", () => {
  test("Mac editing shortcuts select, undo, and redo on a remote host", async () => {
    const { open } = await fixture()
    const tab = await open()
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Remote browser")
    await tab.batch([pointer("mousePressed", 50, 40), pointer("mouseReleased", 50, 40)])
    await tab.send({ kind: "text", text: "original" })
    await tab.batch([...shortcut("KeyA", "a", 65), { kind: "text", text: "replacement" }])
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("replacement")
    await tab.batch(shortcut("KeyZ", "z", 90))
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("original")
    await tab.batch(shortcut("KeyZ", "Z", 90, 12))
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("replacement")
  })

  test("opens host loopback and returns bounded JPEG frames with navigation metadata", async () => {
    const { open, origin, first } = await fixture()
    const query = `/?long=${"q".repeat(2100)}`
    const tab = await open(first.threadId, query)
    await expect
      .poll(async () => (await tab.snapshot()).state)
      .toMatchObject({ title: "Remote browser", loading: false, url: `${origin}${query}` })
    const snapshot = await tab.snapshot()
    expect(snapshot.frame).toMatchObject({ width: 800, height: 600 })
    expect(
      Buffer.from(snapshot.frame?.jpeg ?? "", "base64")
        .subarray(0, 2)
        .toString("hex"),
    ).toBe("ffd8")
    expect(snapshot.frame?.jpeg.length).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect((await tab.snapshot(1_000_000)).frame).toBeNull()
    await tab.close()
    await tab.close()
    await expect(tab.snapshot()).rejects.toThrow(/expired/)
  })

  test("forwards pointer, Unicode text, key release, scroll, and viewport changes", async () => {
    const { open, events } = await fixture()
    const tab = await open()
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Remote browser")
    await tab.send(pointer("mousePressed", 50, 40))
    await tab.send(pointer("mouseReleased", 50, 40))
    await tab.send({ kind: "text", text: "Remote 日本語" })
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Remote 日本語")
    await tab.send({
      kind: "key",
      type: "keyDown",
      key: "Shift",
      code: "ShiftLeft",
      keyCode: 16,
      modifiers: 8,
      text: "",
    })
    await tab.send({ kind: "release" })
    await expect
      .poll(() =>
        events.some((url) => url.searchParams.get("type") === "keyup" && url.searchParams.get("key") === "Shift"),
      )
      .toBe(true)
    await tab.send(pointer("mousePressed", 50, 100))
    await tab.send(pointer("mouseReleased", 50, 100))
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Clicked")
    await tab.send(pointer("mouseWheel", 400, 300))
    await expect
      .poll(() =>
        events.some((url) => url.searchParams.get("type") === "scroll" && Number(url.searchParams.get("y")) > 0),
      )
      .toBe(true)
    await tab.send({ kind: "resize", width: 640, height: 400 })
    await expect.poll(async () => (await tab.snapshot()).frame).toMatchObject({ width: 640, height: 400 })
    await expect
      .poll(() =>
        events.some((url) => url.searchParams.get("type") === "resize" && url.searchParams.get("width") === "640"),
      )
      .toBe(true)
  })

  test("keeps navigation asynchronous and supports back, forward, reload, and stop", async () => {
    const { open, origin } = await fixture()
    const tab = await open()
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Remote browser")
    await tab.send({ kind: "navigate", url: `${origin}/second` })
    await expect.poll(async () => (await tab.snapshot()).state).toMatchObject({ title: "Second page", back: true })
    await tab.send({ kind: "back" })
    await expect
      .poll(async () => (await tab.snapshot()).state)
      .toMatchObject({ title: "Remote browser", forward: true })
    await tab.send({ kind: "forward" })
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Second page")
    await tab.send({ kind: "reload" })
    await expect.poll(async () => (await tab.snapshot()).state.loading).toBe(false)
    await tab.send({ kind: "navigate", url: `${origin}/hang` })
    expect((await tab.snapshot()).state.loading).toBe(true)
    await tab.send({ kind: "stop" })
    expect((await tab.snapshot()).state.loading).toBe(false)
  })

  test("executes input batches in order and refuses empty or oversized batches", async () => {
    const { open } = await fixture()
    const tab = await open()
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Remote browser")
    await tab.batch([
      pointer("mousePressed", 50, 40),
      pointer("mouseReleased", 50, 40),
      { kind: "text", text: "Batched " },
      { kind: "text", text: "日本語" },
      { kind: "release" },
    ])
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Batched 日本語")
    await expect(tab.batch([])).rejects.toThrow()
    await expect(tab.batch(Array.from({ length: 129 }, () => ({ kind: "release" })))).rejects.toThrow()
  })

  test("opens target-blank links and about-blank popups in the current remote tab", async () => {
    const { open, origin, requests } = await fixture()
    const tab = await open()
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Remote browser")
    await tab.batch([pointer("mousePressed", 40, 268), pointer("mouseReleased", 40, 268)])
    await expect
      .poll(async () => (await tab.snapshot()).state)
      .toMatchObject({ title: "Second page", url: `${origin}/second`, back: false })
    expect(requests.filter((request) => request.path === "/second")).toHaveLength(1)
    await tab.send({ kind: "navigate", url: origin })
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Remote browser")
    await tab.batch([pointer("mousePressed", 60, 310), pointer("mouseReleased", 60, 310)])
    await expect
      .poll(async () => (await tab.snapshot()).state)
      .toMatchObject({ title: "Second page", url: `${origin}/second` })
    expect(requests.filter((request) => request.path === "/second")).toHaveLength(2)
  })

  test("adopts a popup POST response without replaying it and keeps input and picking on the same session", async () => {
    const { open, origin, requests } = await fixture()
    const tab = await open()
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Remote browser")
    const duringAdoption = tab.snapshot()
    await tab.batch([pointer("mousePressed", 60, 360), pointer("mouseReleased", 60, 360)])
    await duringAdoption
    await expect
      .poll(async () => (await tab.snapshot()).state)
      .toMatchObject({ title: "POST nonce=remote", url: `${origin}/result` })
    expect(requests.filter((request) => request.path === "/result")).toEqual([
      { method: "POST", path: "/result", body: "nonce=remote" },
    ])
    await tab.batch([
      pointer("mousePressed", 60, 40),
      pointer("mouseReleased", 60, 40),
      { kind: "text", text: "Edited popup" },
    ])
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Edited popup")
    await tab.send({ kind: "pick", enabled: true })
    await expect.poll(async () => (await tab.snapshot()).state.pick.kind).toBe("selecting")
    await tab.batch([
      pointer("mouseMoved", 60, 120),
      pointer("mousePressed", 60, 120),
      pointer("mouseReleased", 60, 120),
    ])
    await expect
      .poll(async () => (await tab.snapshot()).state.pick)
      .toMatchObject({
        kind: "picked",
        attachment: { element: { selector: "#adopted-target", text: "Adopted target" } },
      })
  })

  test("retains document content written into an about-blank popup", async () => {
    const { open, requests, deliverPopup } = await fixture()
    const tab = await open()
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Remote browser")
    await tab.batch([pointer("mousePressed", 60, 410), pointer("mouseReleased", 60, 410)])
    const pendingFrame = tab.snapshot()
    await expect.poll(() => requests.some((request) => request.path === "/popup-content")).toBe(true)
    deliverPopup()
    await pendingFrame
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Written popup")
  })

  test("picks a remote element and stages its screenshot on the host", async () => {
    const { open, origin, first } = await fixture()
    const path = `/?long=${"q".repeat(2100)}`
    const tab = await open(first.threadId, path)
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Remote browser")
    await tab.send({ kind: "pick", enabled: true })
    await expect.poll(async () => (await tab.snapshot()).state.pick.kind).toBe("selecting")
    await tab.send(pointer("mouseMoved", 60, 160))
    await tab.send(pointer("mousePressed", 60, 160))
    await tab.send(pointer("mouseReleased", 60, 160))
    await expect.poll(async () => (await tab.snapshot()).state.pick.kind).toBe("picked")
    const { pick } = (await tab.snapshot()).state
    if (pick.kind !== "picked") throw new Error("Element was not picked")
    expect(pick.attachment.element).toMatchObject({
      url: `${origin}${path}`.slice(0, 2048),
      selector: "#target",
      text: "Pick target",
    })
    expect((await readFile(pick.attachment.path)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
    await tab.send({ kind: "pick", enabled: true })
    await tab.send({ kind: "navigate", url: `${origin}/second` })
    await expect
      .poll(async () => (await tab.snapshot()).state)
      .toMatchObject({ title: "Second page", pick: { kind: "idle" } })
  })

  test("shares cookies within a thread, isolates other threads, and rejects cross-thread commands", async () => {
    const { open, first, second, browser, runtime } = await fixture()
    const original = await open(first.threadId, "/set-cookie")
    await expect.poll(async () => (await original.snapshot()).state.loading).toBe(false)
    const [sameThread, otherThread] = await Promise.all([
      open(first.threadId, "/cookie"),
      open(second.threadId, "/cookie"),
    ])
    await expect.poll(async () => (await sameThread.snapshot()).state.title).toBe("session=thread-a")
    await expect.poll(async () => (await otherThread.snapshot()).state.title).toBe("empty")
    const wrong = { threadId: second.threadId, sessionId: original.sessionId }
    await expect(runtime.runPromise(browser.frame({ ...wrong, after: 0, visible: true }))).rejects.toThrow(/thread/)
    await expect(runtime.runPromise(browser.command({ ...wrong, commands: [{ kind: "reload" }] }))).rejects.toThrow(
      /thread/,
    )
    await expect(runtime.runPromise(browser.close(wrong))).rejects.toThrow(/thread/)
    await original.close()
    expect((await sameThread.snapshot()).state.title).toBe("session=thread-a")
    await expect(
      runtime.runPromise(browser.open({ threadId: "missing", url: "http://127.0.0.1", width: 800, height: 600 })),
    ).rejects.toThrow(/thread/)
  })

  test("refuses non-web navigation and invalid commands at the host boundary", async () => {
    const { open, origin } = await fixture()
    const tab = await open()
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Remote browser")
    await expect(tab.send({ kind: "navigate", url: "file:///etc/passwd" })).rejects.toThrow()
    await expect(tab.send({ kind: "resize", width: 100000, height: 600 })).rejects.toThrow()
    await tab.send({ kind: "navigate", url: `${origin}/redirect-file` })
    await expect.poll(async () => (await tab.snapshot()).state.failure).toBeTypeOf("string")
    expect((await tab.snapshot()).state.url).not.toMatch(/^file:/)
  })

  test("pauses hidden viewing and resumes with a usable frame", async () => {
    const { open } = await fixture()
    const tab = await open()
    await expect.poll(async () => (await tab.snapshot(0, false)).state.title).toBe("Remote browser")
    expect((await tab.snapshot(0, false)).frame).toBeNull()
    const initial = await tab.snapshot()
    expect(initial.frame?.jpeg).toBeTruthy()
    expect((await tab.snapshot(0, false)).frame).toBeNull()
    expect((await tab.snapshot(initial.frame?.sequence ?? 0)).frame?.jpeg).toBeTruthy()
  })

  test("expires abandoned sessions and closes sessions with the service scope", async () => {
    const { open, runtime, browser } = await fixture({ leaseMs: 700, sweepMs: 30 })
    const tab = await open()
    await expect.poll(async () => (await tab.snapshot()).state.title).toBe("Remote browser")
    await Effect.runPromise(Effect.sleep(900))
    await expect(tab.snapshot()).rejects.toThrow(/expired/)
    const replacement = await open()
    await runtime.dispose()
    await expect(
      Effect.runPromise(
        browser.frame({ threadId: replacement.threadId, sessionId: replacement.sessionId, after: 0, visible: true }),
      ),
    ).rejects.toThrow(/expired/)
  })

  test("reports browser setup instructions when Chromium cannot launch", async () => {
    const { open } = await fixture({ executablePath: "/missing/hinacode-browser" })
    await expect(open()).rejects.toThrow(/npx playwright install chromium/)
  })
})
