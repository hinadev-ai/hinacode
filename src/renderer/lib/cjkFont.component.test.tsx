import { afterEach, beforeEach, expect, test } from "vitest"
import "../index.css"

let previousLang = ""

beforeEach(() => {
  previousLang = document.documentElement.lang
})

afterEach(() => {
  document.documentElement.lang = previousLang
})

function rootVariable(lang: string, name: string) {
  document.documentElement.lang = lang
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function minWidthOf(lang: string, className: string) {
  document.documentElement.lang = lang
  const probe = document.createElement("span")
  probe.className = className
  document.body.append(probe)
  const minWidth = getComputedStyle(probe).minWidth
  probe.remove()
  return minWidth
}

test("Simplified Chinese renders in Noto Sans SC", () => {
  expect(rootVariable("zh-CN", "--font-cjk")).toContain("Noto Sans SC Variable")
})

test("Simplified Chinese messages get the same line height as Traditional Chinese", () => {
  expect(rootVariable("zh-CN", "--leading-message")).toBe(rootVariable("zh-TW", "--leading-message"))
})

test("the cjk variant applies to Simplified Chinese", () => {
  expect(minWidthOf("zh-CN", "min-w-8 cjk:min-w-10")).toBe(minWidthOf("zh-TW", "min-w-8 cjk:min-w-10"))
})
