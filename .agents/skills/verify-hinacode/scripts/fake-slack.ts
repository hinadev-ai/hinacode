#!/usr/bin/env node
import { createServer } from "node:http"
import { Effect, Queue } from "effect"
import { makeFakeSlack } from "../../../../src/main/services/slack/fakeSlack.ts"

const workspace = {
  appToken: "xapp-1-demo",
  botToken: "xoxb-demo",
  team: { id: "T1", name: "Acme" },
  bot: "hinacode",
  users: { U1: { team_id: "T1", name: "dev", real_name: "Dev Eloper" }, U9: { team_id: "T9", name: "guest" } },
}

const controlPort = Number(process.argv[2] ?? 47911)
const pingEvery = Number(process.argv[3] ?? 5000)

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
      createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://control")
        const done = (text: string) => response.end(`${text}\n`)
        if (url.pathname === "/dm") {
          const payload = {
            team_id: "T1",
            event: {
              type: "message",
              channel_type: "im",
              channel: "D1",
              ts: "1700000000.000100",
              user: url.searchParams.get("user"),
              text: url.searchParams.get("text"),
            },
          }
          return void Effect.runPromise(fake.deliver(payload)).then(done)
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
