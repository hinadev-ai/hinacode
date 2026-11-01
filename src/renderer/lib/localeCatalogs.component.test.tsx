import { expect, test } from "vitest"
import { m } from "../paraglide/messages.js"
import { setLocale } from "../paraglide/runtime.js"
import { loadLocale } from "./localeCatalogs.ts"

test("a locale speaks English until its catalog loads", async () => {
  expect(m.thread_composer_send({}, { locale: "zh-CN" })).toBe("Send")

  await loadLocale("zh-CN")

  expect(m.thread_composer_send({}, { locale: "zh-CN" })).toBe("发送")
  expect(m.agents_running_count({ count: 2 }, { locale: "zh-CN" })).toBe("2 个运行中")
  expect(m.thread_composer_send({}, { locale: "ja" })).toBe("Send")
})

test("messages follow the current locale once it is loaded", async () => {
  await loadLocale("ja")
  setLocale("ja", { reload: false })

  expect(m.thread_composer_send()).toBe("送信")
  setLocale("en", { reload: false })
})
