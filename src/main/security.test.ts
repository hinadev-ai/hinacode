import { describe, expect, test } from "@effect/vitest"
import { externalUrl, isAppDocument, isTrustedSender } from "./security.ts"

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
