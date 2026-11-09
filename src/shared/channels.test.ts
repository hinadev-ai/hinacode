import { describe, expect, it } from "vitest"
import {
  artifactUrl,
  attachmentUrl,
  desktopResourceUrl,
  externalImageUrl,
  githubAssetUrl,
  projectFileUrl,
  webResourceUrl,
} from "./channels.ts"

const roundTrip = (url: string) => desktopResourceUrl(new URL(webResourceUrl(url), "https://code.test"))

describe("resource URLs on the web", () => {
  it("serves attachments, project files and artifacts from the page's origin and back", () => {
    for (const url of [
      attachmentUrl("/tmp/a b/報告.png", "env-1"),
      projectFileUrl("/repo", "docs/a #1.md"),
      artifactUrl("report-1", "assets/x.png"),
    ]) {
      expect(webResourceUrl(url)).toMatch(/^\/_r\/hinacode-/)
      expect(roundTrip(url)).toBe(url)
    }
  })

  it("resolves a relative path against a served project file like the desktop scheme does", () => {
    const page = new URL(webResourceUrl(projectFileUrl("/repo", "site/index.html")), "https://code.test")
    expect(desktopResourceUrl(new URL("style.css", page))).toBe(projectFileUrl("/repo", "site/style.css"))
  })

  it("loads external images and GitHub assets from their own URL", () => {
    expect(webResourceUrl(externalImageUrl("https://img.example/a.png?x=1") ?? "")).toBe(
      "https://img.example/a.png?x=1",
    )
    const asset = "https://github.com/user-attachments/assets/0f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b"
    expect(webResourceUrl(githubAssetUrl(asset) ?? "")).toBe(asset)
  })

  it("leaves every other URL alone", () => {
    expect(webResourceUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA")
    expect(desktopResourceUrl(new URL("https://code.test/assets/app.js"))).toBeNull()
  })
})
