const platform =
  "userAgentData" in navigator &&
  typeof navigator.userAgentData === "object" &&
  navigator.userAgentData !== null &&
  "platform" in navigator.userAgentData &&
  typeof navigator.userAgentData.platform === "string"
    ? navigator.userAgentData.platform
    : navigator.platform

export const isMac = /mac/i.test(platform)
export const isTouch = matchMedia("(pointer: coarse)").matches
export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches

if (/linux/i.test(platform) && !/android/i.test(navigator.userAgent)) {
  for (const label of document.querySelectorAll("[data-download-label]")) label.textContent = "Download for Linux"
}
if (!isMac) {
  for (const key of document.querySelectorAll('[data-key="mod"]')) key.textContent = "Ctrl"
  for (const key of document.querySelectorAll('[data-key="shift"]')) key.textContent = "Shift"
}
