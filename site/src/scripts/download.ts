import { LATEST_RELEASE_API } from "../links.ts"

type Platform = "mac" | "windows" | "linux" | "other"
type Release = { assets?: { name?: unknown; browser_download_url?: unknown }[] }

const assetSuffix: Record<Exclude<Platform, "other">, string> = {
  mac: ".dmg",
  windows: "-setup.exe",
  linux: ".AppImage",
}

function detectPlatform(): Platform {
  const agent = navigator.userAgent
  if (/iPhone|iPad|Android/i.test(agent)) return "other"
  if (/Mac/i.test(agent)) return "mac"
  if (/Win/i.test(agent)) return "windows"
  if (/Linux|X11|CrOS/i.test(agent)) return "linux"
  return "other"
}

const platform = detectPlatform()
const links = [...document.querySelectorAll<HTMLAnchorElement>("a[data-download]")]

for (const link of links) {
  const label = link.querySelector("[data-download-label]")
  if (label && link.dataset["download"] === "platform") label.textContent = link.dataset[platform] ?? label.textContent
}

if (platform !== "other") {
  const suffix = assetSuffix[platform]
  fetch(LATEST_RELEASE_API)
    .then((response) => (response.ok ? (response.json() as Promise<Release>) : null))
    .then((release) => {
      const asset = release?.assets?.find(({ name }) => typeof name === "string" && name.endsWith(suffix))
      const url = asset?.browser_download_url
      if (typeof url === "string" && url.startsWith("https://github.com/")) for (const link of links) link.href = url
    })
    .catch(() => {})
}
