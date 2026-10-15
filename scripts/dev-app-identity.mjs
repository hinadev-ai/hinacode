// `pnpm dev` runs the stock Electron.app, and macOS reads the Dock label, the menu bar title, Cmd+Tab and
// notifications from that bundle, not from `app.setName`. Rename it and give it our icon, then re-sign it
// ad hoc, as it was signed before, so the edited Info.plist still matches the signature.
// Electron downloads its binary on first use, so resolving `electron` here fetches it before we edit it.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const NAME = "KKCode"

const bundle =
  process.platform === "darwin" ? join(createRequire(import.meta.url)("electron"), "..", "..", "..") : undefined
const plist = bundle && join(bundle, "Contents", "Info.plist")
const plistBuddy = (command) =>
  execFileSync("/usr/libexec/PlistBuddy", ["-c", command, plist], { encoding: "utf8" }).trim()

if (plist && existsSync(plist) && plistBuddy("Print :CFBundleName") !== NAME) {
  plistBuddy(`Set :CFBundleName ${NAME}`)
  plistBuddy(`Set :CFBundleDisplayName ${NAME}`)

  const iconset = join(mkdtempSync(join(tmpdir(), "kkcode-icon-")), "icon.iconset")
  mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const out = join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)
      const px = String(size * scale)
      execFileSync("sips", ["-z", px, px, "assets/icon.png", "--out", out], { stdio: "ignore" })
    }
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(bundle, "Contents", "Resources", "electron.icns")])
  rmSync(dirname(iconset), { recursive: true })

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "ignore" })
}
