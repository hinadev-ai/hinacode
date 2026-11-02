import { describe, expect, test } from "@effect/vitest"
import { socketCandidates } from "./target.ts"

describe("socketCandidates", () => {
  test("tries the packaged desktop, the dev desktop, then the cloud", () => {
    expect(socketCandidates({ dataFlag: undefined, env: {}, home: "/home/me" })).toStrictEqual([
      "/home/me/.hinacode/run/cli.sock",
      "/home/me/.hinacode-dev/run/cli.sock",
      "/home/me/.hinacode-cloud/run/cli.sock",
    ])
  })

  test("tries HINACODE_USER_DATA first and does not repeat a default", () => {
    expect(
      socketCandidates({
        dataFlag: undefined,
        env: { HINACODE_USER_DATA: "/home/me/.hinacode-cloud" },
        home: "/home/me",
      }),
    ).toStrictEqual([
      "/home/me/.hinacode-cloud/run/cli.sock",
      "/home/me/.hinacode/run/cli.sock",
      "/home/me/.hinacode-dev/run/cli.sock",
    ])
  })

  test("reaches only the directory --data names", () => {
    expect(
      socketCandidates({ dataFlag: "/srv/cloud", env: { HINACODE_USER_DATA: "/tmp/other" }, home: "/home/me" }),
    ).toStrictEqual(["/srv/cloud/run/cli.sock"])
  })
})
