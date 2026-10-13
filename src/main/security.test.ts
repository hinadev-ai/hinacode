import { describe, expect, test } from "@effect/vitest"
import {
  BROWSER_PARTITION,
  externalUrl,
  isAppDocument,
  isInside,
  isTrustedSender,
  lockDownWebview,
} from "./security.ts"

const packagedDocument = "file:///opt/kkcode/resources/app.asar/out/renderer/index.html"
const resolved = (href: string) => new URL(href, packagedDocument).href

describe("externalUrl", () => {
  test("allows http and https", () => {
    expect(externalUrl("https://github.com/kjj6198/kkcode/pull/1")).toBe("https://github.com/kjj6198/kkcode/pull/1")
    expect(externalUrl("http://example.com/a?b=1#c")).toBe("http://example.com/a?b=1#c")
  })

  test("rejects file URLs, including relative and UNC-style links resolved against the app document", () => {
    expect(externalUrl("file:///etc/passwd")).toBe(null)
    expect(externalUrl(resolved("/tmp/kkcode-audit-link-target.txt"))).toBe(null)
    expect(externalUrl(resolved("notes/readme.md"))).toBe(null)
    expect(externalUrl(resolved("//host/share/payload.exe"))).toBe(null)
    expect(externalUrl(resolved("\\\\host\\share\\payload.exe"))).toBe(null)
  })

  test("rejects unparseable input and paths that are not URLs", () => {
    expect(externalUrl("\\\\host\\share\\payload.exe")).toBe(null)
    expect(externalUrl("/tmp/x")).toBe(null)
    expect(externalUrl("")).toBe(null)
  })

  test("rejects script and custom protocol handlers", () => {
    expect(externalUrl("javascript:alert(1)")).toBe(null)
    expect(externalUrl("JaVaScRiPt:alert(1)")).toBe(null)
    expect(externalUrl("data:text/html,<script>alert(1)</script>")).toBe(null)
    expect(externalUrl("mailto:someone@example.com")).toBe(null)
    expect(externalUrl("vscode://file/etc/passwd")).toBe(null)
    expect(externalUrl("ms-msdt:/id PCWDiagnostic")).toBe(null)
    expect(externalUrl("smb://host/share")).toBe(null)
  })
})

const devServer = "http://localhost:5173"
const mainFrame = (url: string) => ({ url, parent: null })

describe("isAppDocument", () => {
  test("accepts the packaged document, ignoring query and fragment", () => {
    expect(isAppDocument(packagedDocument, packagedDocument)).toBe(true)
    expect(isAppDocument(`${packagedDocument}?x=1#/thread`, packagedDocument)).toBe(true)
  })

  test("rejects other local files, remote pages and opaque URLs from the packaged app", () => {
    expect(isAppDocument("file:///tmp/kkcode-audit/probe.html", packagedDocument)).toBe(false)
    expect(isAppDocument(resolved("other.html"), packagedDocument)).toBe(false)
    expect(isAppDocument("file://host/opt/kkcode/resources/app.asar/out/renderer/index.html", packagedDocument)).toBe(
      false,
    )
    expect(isAppDocument("https://example.com/", packagedDocument)).toBe(false)
    expect(isAppDocument("data:text/html,<h1>x</h1>", packagedDocument)).toBe(false)
    expect(isAppDocument("about:blank", packagedDocument)).toBe(false)
    expect(isAppDocument("not a url", packagedDocument)).toBe(false)
  })

  test("accepts any path on the dev server origin and nothing else", () => {
    expect(isAppDocument("http://localhost:5173/", devServer)).toBe(true)
    expect(isAppDocument("http://localhost:5173/src/renderer/index.html", devServer)).toBe(true)
    expect(isAppDocument("http://localhost:5174/", devServer)).toBe(false)
    expect(isAppDocument("https://localhost:5173/", devServer)).toBe(false)
    expect(isAppDocument("http://127.0.0.1:5173/", devServer)).toBe(false)
    expect(isAppDocument(packagedDocument, devServer)).toBe(false)
  })
})

describe("isTrustedSender", () => {
  test("accepts the main frame showing the app document", () => {
    expect(isTrustedSender(mainFrame(packagedDocument), packagedDocument)).toBe(true)
    expect(isTrustedSender(mainFrame("http://localhost:5173/"), devServer)).toBe(true)
  })

  test("rejects subframes even on the app document", () => {
    expect(isTrustedSender({ url: packagedDocument, parent: mainFrame(packagedDocument) }, packagedDocument)).toBe(
      false,
    )
  })

  test("rejects foreign documents and destroyed frames", () => {
    expect(isTrustedSender(mainFrame("file:///tmp/kkcode-audit/probe.html"), packagedDocument)).toBe(false)
    expect(isTrustedSender(mainFrame("https://example.com/"), devServer)).toBe(false)
    expect(isTrustedSender(null, packagedDocument)).toBe(false)
  })
})

describe("isInside", () => {
  test("accepts the root itself and paths under it", () => {
    expect(isInside("/repo", "/repo")).toBe(true)
    expect(isInside("/repo", "/repo/src/a.ts")).toBe(true)
    expect(isInside("/repo", "/repo/..hidden")).toBe(true)
  })

  test("rejects parents, siblings sharing a prefix, and relative paths", () => {
    expect(isInside("/repo", "/")).toBe(false)
    expect(isInside("/repo", "/repo-other/a.ts")).toBe(false)
    expect(isInside("/repo", "/repo/../etc/passwd")).toBe(false)
    expect(isInside("/repo", "src/a.ts")).toBe(false)
  })
})

describe("lockDownWebview", () => {
  test("strips the preload and forces the sandbox and the browser session", () => {
    const preferences: Record<string, unknown> = {
      preload: "file:///tmp/evil.js",
      preloadURL: "file:///tmp/evil.js",
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      partition: "persist:app",
    }
    const params: Record<string, string> = { src: "http://localhost:5173/", partition: "persist:app" }

    expect(lockDownWebview(preferences, params)).toBe(true)
    expect(preferences).toEqual({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: BROWSER_PARTITION,
    })
    expect(params["partition"]).toBe(BROWSER_PARTITION)
  })

  test("refuses a first URL that is not http(s)", () => {
    for (const src of ["file:///etc/passwd", "javascript:alert(1)", "kkcode-attachment://file/x", ""]) {
      expect(lockDownWebview({}, { src })).toBe(false)
    }
  })
})
