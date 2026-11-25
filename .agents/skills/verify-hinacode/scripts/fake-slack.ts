#!/usr/bin/env node
import { createServer } from "node:http"
import { Effect, Queue } from "effect"
import { makeFakeSlack } from "../../../../src/main/services/slack/fakeSlack.ts"

const workspace = {
  appToken: "xapp-1-demo",
  botToken: "xoxb-demo",
  team: { id: "T1", name: "Acme", url: "https://acme.slack.com/" },
  bot: "hinacode",
}

const controlPort = Number(process.argv[2] ?? 47911)
const pingEvery = Number(process.argv[3] ?? 5000)

let sent = 0
const messageFrom = (url: URL) => {
  sent += 1
  const thread = url.searchParams.get("thread")
  return {
    channel: url.searchParams.get("channel") ?? "C1",
    ts: url.searchParams.get("ts") ?? `${1700000000 + sent * 100}.000100`,
    ...(thread !== null && { thread_ts: thread }),
    user: url.searchParams.get("user") ?? "U1",
    text: url.searchParams.get("text") ?? "",
  }
}

const logEach = <A>(queue: Queue.Queue<A>, log: (item: A) => void) =>
  Effect.forkScoped(Effect.forever(Effect.map(Queue.take(queue), log)))

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* makeFakeSlack(workspace)
      console.log(`api ${fake.apiUrl}`)
      console.log(`tokens ${workspace.appToken} ${workspace.botToken}`)
      yield* logEach(fake.links, (socket) => {
        console.log("link opened")
        socket.on("close", () => console.log("link closed"))
        if (pingEvery > 0) setInterval(() => socket.readyState === socket.OPEN && socket.ping(), pingEvery)
      })
      yield* logEach(fake.reactions, (reaction) => console.log("reaction", JSON.stringify(reaction)))
      yield* logEach(fake.posts, (post) => console.log("post", JSON.stringify(post)))
      createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://control")
        const done = (text: string) => response.end(`${text}\n`)
        const run = (effect: Effect.Effect<unknown>, answer: string) =>
          void Effect.runPromise(effect).then(() => done(answer))
        if (url.pathname === "/say") {
          const message = messageFrom(url)
          return run(fake.post(message), message.ts)
        }
        if (url.pathname === "/mention") {
          const message = messageFrom(url)
          return run(fake.mention(message), message.ts)
        }
        if (url.pathname === "/redeliver") {
          const message = messageFrom(url)
          return run(fake.deliver({ team_id: "T1", event: { type: "app_mention", ...message } }), message.ts)
        }
        if (url.pathname === "/refresh") return run(fake.askToRefresh, "asked")
        if (url.pathname === "/drop") return run(fake.drop, "dropped")
        if (url.pathname === "/revoke") return run(fake.revokeAppToken, "revoked")
        done("unknown")
      }).listen(controlPort, "127.0.0.1", () => console.log(`control http://127.0.0.1:${controlPort}`))
      yield* Effect.never
    }),
  ),
)
