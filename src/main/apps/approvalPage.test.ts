import { describe, expect, test } from "vitest"
import {
  type Approver,
  brokenLinkPage,
  localeOf,
  notStartedPage,
  signInFailedPage,
  signInLostPage,
  waitingPage,
} from "./approvalPage.ts"

const SIGNED_OUT: Approver = { signedIn: false, signInPath: "/oauth/sign-in?request=r" }
const SIGNED_IN: Approver = { signedIn: true, email: "dev@example.com", answerPath: "/oauth/answer", request: "r" }

const tileOf = (appName: string, redirectHost: string) =>
  waitingPage({ appName, redirectHost, approver: SIGNED_OUT, locale: "en" }).html.match(
    /<span class="tile ([^"]+)"/,
  )?.[1]

const page = (locale: "en" | "zh-TW" | "ja") =>
  waitingPage({ appName: "Grok", redirectHost: "grok.com", approver: SIGNED_OUT, locale }).html

describe("waiting page", () => {
  test("shows the mark of a known app, by its own domain or, on loopback, by its name", () => {
    expect(tileOf("Grok Bot", "grok.com")).toBe("glyph grok")
    expect(tileOf("Connector", "x.ai")).toBe("glyph grok")
    expect(tileOf("Connector", "connectors.claude.ai")).toBe("glyph claude")
    expect(tileOf("Claude Code", "localhost:4567")).toBe("glyph claude")
    expect(tileOf("MCP client", "chatgpt.com")).toBe("glyph chatgpt")
    expect(tileOf("hermes-agent", "127.0.0.1:9000")).toBe("hermes")
  })

  test("does not lend a brand's mark to an app that only borrows its name", () => {
    expect(tileOf("Claude", "claude.evil.example")).toBe("letter")
    expect(tileOf("Claude", "evil.example")).toBe("letter")
    expect(tileOf("Connector", "evilclaude.ai")).toBe("letter")
    expect(tileOf("Grok Bot", "grok.com.evil.example:8443")).toBe("letter")
  })

  test("falls back to the first letter of any other app", () => {
    const html = waitingPage({
      appName: "  ōtter <i>",
      redirectHost: "otter.example",
      approver: SIGNED_OUT,
      locale: "en",
    }).html
    expect(html).toContain('<span class="tile letter" aria-hidden="true">ō</span>')
    expect(html).toContain("ōtter &#60;i&#62; wants to connect to HinaCode")
  })
})

describe("localeOf", () => {
  test("picks the first acceptable supported language", () => {
    expect(localeOf(undefined)).toBe("en")
    expect(localeOf("")).toBe("en")
    expect(localeOf("en-US,en;q=0.9")).toBe("en")
    expect(localeOf("ja")).toBe("ja")
    expect(localeOf("ja-JP,ja;q=0.9,en;q=0.8")).toBe("ja")
    expect(localeOf("zh-TW")).toBe("zh-TW")
    expect(localeOf("zh-Hant-TW")).toBe("zh-TW")
    expect(localeOf("zh-Hant")).toBe("zh-TW")
  })

  test("orders ranges by quality and skips zero", () => {
    expect(localeOf("en;q=0.4,ja;q=0.9")).toBe("ja")
    expect(localeOf("ja;q=0,en;q=0.5")).toBe("en")
    expect(localeOf("fr-FR,zh-TW;q=0.7")).toBe("zh-TW")
  })

  test("falls back to English for unsupported languages", () => {
    expect(localeOf("zh-CN")).toBe("en")
    expect(localeOf("zh-Hans")).toBe("en")
    expect(localeOf("fr-FR,de;q=0.8")).toBe("en")
    expect(localeOf("*")).toBe("en")
  })
})

describe("rendering", () => {
  test("renders English", () => {
    const html = page("en")
    expect(html).toContain('<html lang="en">')
    expect(html).toContain("Grok wants to connect to HinaCode")
    expect(html).toContain("Sends you back to grok.com")
    expect(html).toContain("Approving lets it:")
    expect(html).toContain("Read your projects and threads")
    expect(html).toContain("Start agents that run code on this machine")
    expect(html).toContain("Send messages to threads and stop them")
    expect(html).toContain("Stay connected until you remove it in HinaCode")
    expect(html).toContain("Sign in to approve")
    expect(html).toContain("Settings &#62; Connections &#62; Apps")
  })

  test("renders Traditional Chinese", () => {
    const html = page("zh-TW")
    expect(html).toContain('<html lang="zh-TW">')
    expect(html).toContain("Grok 想要連接 HinaCode")
    expect(html).toContain("完成後會帶你回到 grok.com")
    expect(html).toContain("核准後，它將可以：")
    expect(html).toContain("讀取你的專案與對話串")
    expect(html).toContain("啟動代理程式，在這台機器上執行程式碼")
    expect(html).toContain("傳送訊息到對話串，並停止對話串")
    expect(html).toContain("保持連線，直到你在 HinaCode 中移除它")
    expect(html).toContain("登入並核准")
    expect(html).toContain("「設定」&#62;「連線」&#62;「應用程式」")
  })

  test("renders Japanese", () => {
    const html = page("ja")
    expect(html).toContain('<html lang="ja">')
    expect(html).toContain("Grok が HinaCode への接続を求めています")
    expect(html).toContain("完了後、grok.com に戻ります")
    expect(html).toContain("承認すると、次のことが許可されます：")
    expect(html).toContain("プロジェクトとスレッドの読み取り")
    expect(html).toContain("このマシンでコードを実行するエージェントの起動")
    expect(html).toContain("スレッドへのメッセージ送信とスレッドの停止")
    expect(html).toContain("HinaCode で削除するまで接続を維持")
    expect(html).toContain("サインインして承認")
    expect(html).toContain("「設定」&#62;「接続」&#62;「アプリ」")
  })

  test("renders the signed-in approve and deny buttons in the chosen locale", () => {
    const japanese = waitingPage({ appName: "Grok", redirectHost: "grok.com", approver: SIGNED_IN, locale: "ja" }).html
    expect(japanese).toContain(">承認</button>")
    expect(japanese).toContain(">拒否</button>")
    expect(japanese).toContain("サインイン中： <strong>dev@example.com</strong>")
    expect(japanese).not.toContain('http-equiv="refresh"')
  })

  test("renders the notice pages in the chosen locale", () => {
    expect(notStartedPage("zh-TW").html).toContain("請從 HinaCode 開始")
    expect(notStartedPage("ja").html).toContain("HinaCode から開始してください")
    expect(brokenLinkPage("zh-TW").html).toContain("此連結無法使用")
    expect(brokenLinkPage("ja").html).toContain("このリンクは使用できません")
    expect(signInLostPage("zh-TW").html).toContain("請重新開啟應用程式的登入頁面")
    expect(signInLostPage("ja").html).toContain("アプリのサインインページをもう一度開き")
    expect(signInFailedPage("en", "relay said no").html).toContain("relay said no")
    expect(signInFailedPage("zh-TW", "relay said no").html).toContain("登入時發生問題")
    expect(signInFailedPage("zh-TW", "relay said no").html).not.toContain("relay said no")
    expect(signInFailedPage("ja", "relay said no").html).toContain("サインイン中に問題が発生しました")
    expect(signInFailedPage("ja", "relay said no").html).not.toContain("relay said no")
  })
})
