import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { externalUrl, isAppDocument, isTrustedSender } from "./security.ts"

const packagedDocument = "file:///opt/kkcode/resources/app.asar/out/renderer/index.html"
const resolved = (href: string) => new URL(href, packagedDocument).href

describe("externalUrl", () => {
  test("allows http and https", () => {
    assert.equal(externalUrl("https://github.com/kjj6198/kkcode/pull/1"), "https://github.com/kjj6198/kkcode/pull/1")
    assert.equal(externalUrl("http://example.com/a?b=1#c"), "http://example.com/a?b=1#c")
  })

  test("rejects file URLs, including relative and UNC-style links resolved against the app document", () => {
    assert.equal(externalUrl("file:///etc/passwd"), null)
    assert.equal(externalUrl(resolved("/tmp/kkcode-audit-link-target.txt")), null)
    assert.equal(externalUrl(resolved("notes/readme.md")), null)
    assert.equal(externalUrl(resolved("//host/share/payload.exe")), null)
    assert.equal(externalUrl(resolved("\\\\host\\share\\payload.exe")), null)
  })

  test("rejects unparseable input and paths that are not URLs", () => {
    assert.equal(externalUrl("\\\\host\\share\\payload.exe"), null)
    assert.equal(externalUrl("/tmp/x"), null)
    assert.equal(externalUrl(""), null)
  })

  test("rejects script and custom protocol handlers", () => {
    assert.equal(externalUrl("javascript:alert(1)"), null)
    assert.equal(externalUrl("JaVaScRiPt:alert(1)"), null)
    assert.equal(externalUrl("data:text/html,<script>alert(1)</script>"), null)
    assert.equal(externalUrl("mailto:someone@example.com"), null)
    assert.equal(externalUrl("vscode://file/etc/passwd"), null)
    assert.equal(externalUrl("ms-msdt:/id PCWDiagnostic"), null)
    assert.equal(externalUrl("smb://host/share"), null)
  })
})

const devServer = "http://localhost:5173"
const mainFrame = (url: string) => ({ url, parent: null })

describe("isAppDocument", () => {
  test("accepts the packaged document, ignoring query and fragment", () => {
    assert.equal(isAppDocument(packagedDocument, packagedDocument), true)
    assert.equal(isAppDocument(`${packagedDocument}?x=1#/thread`, packagedDocument), true)
  })

  test("rejects other local files, remote pages and opaque URLs from the packaged app", () => {
    assert.equal(isAppDocument("file:///tmp/kkcode-audit/probe.html", packagedDocument), false)
    assert.equal(isAppDocument(resolved("other.html"), packagedDocument), false)
    assert.equal(
      isAppDocument("file://host/opt/kkcode/resources/app.asar/out/renderer/index.html", packagedDocument),
      false,
    )
    assert.equal(isAppDocument("https://example.com/", packagedDocument), false)
    assert.equal(isAppDocument("data:text/html,<h1>x</h1>", packagedDocument), false)
    assert.equal(isAppDocument("about:blank", packagedDocument), false)
    assert.equal(isAppDocument("not a url", packagedDocument), false)
  })

  test("accepts any path on the dev server origin and nothing else", () => {
    assert.equal(isAppDocument("http://localhost:5173/", devServer), true)
    assert.equal(isAppDocument("http://localhost:5173/src/renderer/index.html", devServer), true)
    assert.equal(isAppDocument("http://localhost:5174/", devServer), false)
    assert.equal(isAppDocument("https://localhost:5173/", devServer), false)
    assert.equal(isAppDocument("http://127.0.0.1:5173/", devServer), false)
    assert.equal(isAppDocument(packagedDocument, devServer), false)
  })
})

describe("isTrustedSender", () => {
  test("accepts the main frame showing the app document", () => {
    assert.equal(isTrustedSender(mainFrame(packagedDocument), packagedDocument), true)
    assert.equal(isTrustedSender(mainFrame("http://localhost:5173/"), devServer), true)
  })

  test("rejects subframes even on the app document", () => {
    assert.equal(
      isTrustedSender({ url: packagedDocument, parent: mainFrame(packagedDocument) }, packagedDocument),
      false,
    )
  })

  test("rejects foreign documents and destroyed frames", () => {
    assert.equal(isTrustedSender(mainFrame("file:///tmp/kkcode-audit/probe.html"), packagedDocument), false)
    assert.equal(isTrustedSender(mainFrame("https://example.com/"), devServer), false)
    assert.equal(isTrustedSender(null, packagedDocument), false)
  })
})
