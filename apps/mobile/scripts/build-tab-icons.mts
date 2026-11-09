// Renders the tab bar's icons from @hinacode/icons, the set the desktop draws, into template PNGs, because native
// tabs take an image rather than an SVG. iOS gets its own `.ios.png` copies with a thinner stroke, which Metro picks on
// iOS, so the icons sit beside the glass tab bar's system symbols at their weight. Needs rsvg-convert (librsvg). Run with `pnpm build:tab-icons` from
// apps/mobile after `pnpm install` at the repository root, and commit the result.
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import type { ComponentType } from "react"
import { createServer } from "vite"

const root = fileURLToPath(new URL("../../..", import.meta.url))
const out = fileURLToPath(new URL("../assets/images/tabs/", import.meta.url))
const POINTS = 25
const IOS_STROKE = "1.8"

// The root's React, the copy Vite's SSR resolves the icons against, rather than this app's own.
const rootRequire = createRequire(`${root}package.json`)
const { createElement } = rootRequire("react") as typeof import("react")
const { renderToStaticMarkup } = rootRequire("react-dom/server") as typeof import("react-dom/server")

const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "error" })
try {
  const icons = await server.ssrLoadModule("/packages/icons/src/index.ts")
  const remix = await server.ssrLoadModule("react-icons/ri")
  const tabs: Record<string, ComponentType<{ color: string }>> = {
    threads: icons.ChatsIcon,
    "pull-requests": remix.RiGitPullRequestLine,
    artifacts: icons.LayoutIcon,
    settings: icons.SettingsIcon,
    search: icons.SearchIcon,
  }
  mkdirSync(out, { recursive: true })
  for (const [name, Icon] of Object.entries(tabs)) {
    const svg = renderToStaticMarkup(createElement(Icon, { color: "#000" })).replaceAll("currentColor", "#000")
    const variants = { "": svg, ".ios": svg.replaceAll('stroke-width="2.4"', `stroke-width="${IOS_STROKE}"`) }
    for (const [platform, markup] of Object.entries(variants)) {
      for (const scale of [1, 2, 3]) {
        const suffix = `${scale === 1 ? "" : `@${scale}x`}${platform}`
        const size = String(POINTS * scale)
        execFileSync("rsvg-convert", ["-w", size, "-h", size, "-o", `${out}${name}${suffix}.png`], { input: markup })
      }
    }
  }
} finally {
  await server.close()
}
