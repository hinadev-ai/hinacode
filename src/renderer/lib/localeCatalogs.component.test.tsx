import { expect, test } from "vitest"
import { m } from "../paraglide/messages.js"
import { loadLocale } from "./localeCatalogs.ts"

test("a locale speaks English until its catalog loads", async () => {
  expect(m.thread_composer_send({}, { locale: "zh-CN" })).toBe("Send")

  await loadLocale("zh-CN")

  expect(m.thread_composer_send({}, { locale: "zh-CN" })).toBe("发送")
  expect(m.agents_running_count({ count: 2 }, { locale: "zh-CN" })).toBe("2 个运行中")
  expect(m.thread_composer_send({}, { locale: "ja" })).toBe("Send")
})
