import { describe, expect, test } from "@effect/vitest"
import { attachmentUrl, githubAssetUrl, projectFileUrl } from "../shared/channels.ts"
import {
  attachmentRequest,
  BROWSER_PARTITION,
  externalUrl,
  githubAssetId,
  isAllowedNavigation,
  isAppDocument,
  isInside,
  isTrustedSender,
  lockDownWebview,
  projectFileRequest,
} from "./security.ts"

const packagedDocument = "file:///opt/hinacode/resources/app.asar/out/renderer/index.html"
const resolved = (href: string) => new URL(href, packagedDocument).href

describe("externalUrl", () => {
  test("allows http and https", () => {
    expect(externalUrl("https://github.com/hinadev-ai/hinacode/pull/1")).toBe(
      "https://github.com/hinadev-ai/hinacode/pull/1",
    )
    expect(externalUrl("http://example.com/a?b=1#c")).toBe("http://example.com/a?b=1#c")
  })

  test("rejects file URLs, including relative and UNC-style links resolved against the app document", () => {
    expect(externalUrl("file:///etc/passwd")).toBe(null)
    expect(externalUrl(resolved("/tmp/hinacode-audit-link-target.txt"))).toBe(null)
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
    expect(isAppDocument("file:///tmp/hinacode-audit/probe.html", packagedDocument)).toBe(false)
    expect(isAppDocument(resolved("other.html"), packagedDocument)).toBe(false)
    expect(isAppDocument("file://host/opt/hinacode/resources/app.asar/out/renderer/index.html", packagedDocument)).toBe(
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
    expect(isTrustedSender(mainFrame("file:///tmp/hinacode-audit/probe.html"), packagedDocument)).toBe(false)
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
    for (const src of ["file:///etc/passwd", "javascript:alert(1)", "hinacode-attachment://file/x", ""]) {
      expect(lockDownWebview({}, { src })).toBe(false)
    }
  })
})

describe("githubAssetId", () => {
  const id = "e21c7bd2-dd8d-4549-a268-04bdaea6355b"

  test("round-trips a user-attachments link", () => {
    const url = githubAssetUrl(`https://github.com/user-attachments/assets/${id}`)
    expect(url === null ? null : githubAssetId(url)).toBe(id)
  })

  test("refuses anything but a bare attachment id, so the proxy only ever asks GitHub for an attachment", () => {
    expect(githubAssetUrl(`https://github.com/user-attachments/assets/${id}/../../settings`)).toBe(null)
    expect(githubAssetUrl(`https://evil.example/user-attachments/assets/${id}`)).toBe(null)
    expect(githubAssetId(`hinacode-github-asset://asset/${id}/x`)).toBe(null)
    expect(githubAssetId(`hinacode-github-asset://other/${id}`)).toBe(null)
    expect(githubAssetId(`hinacode-github-asset://asset/..%2F${id}`)).toBe(null)
  })
})

describe("projectFileRequest", () => {
  test("round-trips roots and paths with spaces, reserved characters and non-ASCII names", () => {
    const root = "/Users/me/my repo#1"
    const path = "docs/報告 ?.html"
    expect(projectFileRequest(projectFileUrl(root, path))).toEqual({ root, path })
  })

  test("resolves a relative link from a served page to a sibling under the same root", () => {
    const page = projectFileUrl("/repo", "site/index.html")
    expect(projectFileRequest(new URL("style.css", page).href)).toEqual({ root: "/repo", path: "site/style.css" })
  })

  test("a link that climbs out of the root names a different, unknown root instead of a file outside it", () => {
    const page = projectFileUrl("/repo", "index.html")
    expect(projectFileRequest(new URL("../../etc/passwd", page).href)).toEqual({ root: "etc", path: "passwd" })
  })

  test("refuses other hosts and malformed escapes", () => {
    expect(projectFileRequest("hinacode-file://other/%2Frepo/a.png")).toBe(null)
    expect(projectFileRequest("hinacode-file://root/%E0%A4%A/a.png")).toBe(null)
    expect(projectFileRequest("hinacode-file://root/")).toBe(null)
  })
})

describe("attachmentRequest", () => {
  test("round-trips a path with spaces and non-ASCII names, on this machine or a cloud", () => {
    const path = "/Users/me/Library/Application Support/kkcode/attachments/t/画面 #1.png"
    expect(attachmentRequest(attachmentUrl(path))).toEqual({ path, environment: null })
    expect(attachmentRequest(attachmentUrl(path, "env-1"))).toEqual({ path, environment: "env-1" })
  })

  test("refuses other schemes, other hosts and malformed escapes", () => {
    expect(attachmentRequest("file:///etc/passwd")).toBe(null)
    expect(attachmentRequest("hinacode-attachment://other/%2Fetc%2Fpasswd")).toBe(null)
    expect(attachmentRequest("hinacode-attachment://file/%E0%A4%A")).toBe(null)
  })
})

describe("isAllowedNavigation", () => {
  const preview = projectFileUrl("/repo", "site/index.html")

  test("keeps the top frame on the app document, never on a project file", () => {
    expect(isAllowedNavigation(packagedDocument, true, packagedDocument)).toBe(true)
    expect(isAllowedNavigation(preview, true, packagedDocument)).toBe(false)
    expect(isAllowedNavigation("https://example.com", true, packagedDocument)).toBe(false)
  })

  test("lets a subframe load project files only", () => {
    expect(isAllowedNavigation(preview, false, packagedDocument)).toBe(true)
    expect(isAllowedNavigation(packagedDocument, false, packagedDocument)).toBe(false)
    expect(isAllowedNavigation("https://example.com", false, packagedDocument)).toBe(false)
    expect(isAllowedNavigation("file:///etc/passwd", false, packagedDocument)).toBe(false)
  })
})
