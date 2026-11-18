#!/usr/bin/env node
import { createServer } from "node:http"
import { Effect, Queue } from "effect"
import { makeFakeSlack } from "../../../../src/main/services/slack/fakeSlack.ts"

const workspace = {
  appToken: "xapp-1-demo",
  botToken: "xoxb-demo",
  team: { id: "T1", name: "Acme" },
  bot: "hinacode",
  users: {
    U1: { team_id: "T1", name: "dev", real_name: "Dev Eloper" },
    U2: { team_id: "T1", name: "mei", real_name: "Mei" },
    U9: { team_id: "T9", name: "guest" },
  },
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

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* makeFakeSlack(workspace)
      console.log(`api ${fake.apiUrl}`)
      console.log(`tokens ${workspace.appToken} ${workspace.botToken}`)
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.map(Queue.take(fake.links), (socket) => {
            console.log("link opened")
            socket.on("close", () => console.log("link closed"))
            if (pingEvery > 0) setInterval(() => socket.readyState === socket.OPEN && socket.ping(), pingEvery)
          }),
        ),
      )
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.map(Queue.take(fake.reactions), (reaction) => console.log("reaction", JSON.stringify(reaction))),
        ),
      )
      yield* Effect.forkScoped(
        Effect.forever(Effect.map(Queue.take(fake.notes), (note) => console.log("note", JSON.stringify(note)))),
      )
      yield* Effect.forkScoped(
        Effect.forever(Effect.map(Queue.take(fake.posts), (post) => console.log("post", JSON.stringify(post)))),
      )
      createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://control")
        const done = (text: string) => response.end(`${text}\n`)
        if (url.pathname === "/dm") {
          const message = { ...messageFrom(url), channel: "D1" }
          const payload = { team_id: "T1", event: { type: "message", channel_type: "im", ...message } }
          return void Effect.runPromise(Effect.andThen(fake.post(message), fake.deliver(payload))).then(() =>
            done(message.ts),
          )
        }
        if (url.pathname === "/say") {
          const message = messageFrom(url)
          return void Effect.runPromise(fake.post(message)).then(() => done(message.ts))
        }
        if (url.pathname === "/mention") {
          const message = messageFrom(url)
          const payload = { team_id: "T1", event: { type: "app_mention", ...message } }
          return void Effect.runPromise(Effect.andThen(fake.post(message), fake.deliver(payload))).then(() =>
            done(message.ts),
          )
        }
        if (url.pathname === "/refresh") return void Effect.runPromise(fake.askToRefresh).then(() => done("asked"))
        if (url.pathname === "/drop") return void Effect.runPromise(fake.drop).then(() => done("dropped"))
        if (url.pathname === "/revoke") return void Effect.runPromise(fake.revokeAppToken).then(() => done("revoked"))
        done("unknown")
      }).listen(controlPort, "127.0.0.1", () => console.log(`control http://127.0.0.1:${controlPort}`))
      yield* Effect.never
    }),
  ),
)
