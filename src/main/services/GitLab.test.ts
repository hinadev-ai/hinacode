import { describe, expect, it, test } from "@effect/vitest"
import { Effect, Layer, Schema, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { Events } from "./Events.ts"
import { CommandError } from "./Git.ts"
import {
  ApprovalsJson,
  DiffsJson,
  diffStat,
  GitLab,
  GitLabApiError,
  GitLabCliMissingError,
  gitLabErrorOf,
  GitLabSignedOutError,
  JobsJson,
  layer,
  MergeRequestJson,
  mergeRequestUrlIn,
  NotesJson,
  pipelineChecks,
  toCheckRuns,
  toPullRequest,
  toPullRequestDetail,
} from "./GitLab.ts"
import * as fixtures from "./GitLab.fixtures.ts"

const mergeRequest = Schema.decodeUnknownSync(MergeRequestJson)
const approvals = Schema.decodeUnknownSync(ApprovalsJson)
const diffs = Schema.decodeUnknownSync(DiffsJson)
const jobs = Schema.decodeUnknownSync(JobsJson)
const notes = Schema.decodeUnknownSync(NotesJson)

const MERGED_URL = "https://gitlab.com/gitlab-org/cli/-/merge_requests/4335"
const OPEN_URL = "https://gitlab.com/gitlab-org/cli/-/merge_requests/4344"

const merged = {
  url: MERGED_URL,
  mergeRequest: mergeRequest(fixtures.mergeRequest4335),
  approvals: approvals(fixtures.approvals4335),
  diffs: diffs(fixtures.diffs4335),
}

const open = {
  url: OPEN_URL,
  mergeRequest: mergeRequest(fixtures.mergeRequest4344),
  approvals: approvals(fixtures.approvals4344),
  diffs: diffs(fixtures.diffs4344),
}

const openWith = (overrides: Record<string, unknown>) => ({
  ...open,
  mergeRequest: mergeRequest({ ...fixtures.mergeRequest4344, ...overrides }),
})

describe("toPullRequest", () => {
  test("maps a merged merge request with an approved, passing pipeline", () => {
    expect(toPullRequest(merged)).toStrictEqual({
      url: MERGED_URL,
      number: 4335,
      title: "docs(skills): expand glab-stack guidance for non-interactive reorder and infer",
      status: "merged",
      checks: "passing",
      review: "approved",
      mergeable: "mergeable",
      author: "jay_mccure",
      headRefName: "jmc-stack-skill-reorder-infer-followup",
      baseRefName: "main",
      additions: 31,
      deletions: 6,
      mergedAt: "2026-11-06T02:14:57.439Z",
    })
  })

  test("maps an open merge request that still needs approval", () => {
    expect(toPullRequest(open)).toMatchObject({
      number: 4344,
      status: "open",
      checks: "passing",
      review: "reviewRequired",
      mergeable: "mergeable",
      headRefName: "jmc-coverage-skip-on-test-failure",
      additions: 4,
      deletions: 0,
      mergedAt: null,
    })
  })

  test("reads draft, closed and locked states", () => {
    expect(toPullRequest(openWith({ draft: true })).status).toBe("draft")
    expect(toPullRequest(openWith({ state: "closed" })).status).toBe("closed")
    expect(toPullRequest(openWith({ state: "locked" })).status).toBe("closed")
  })

  test("reads requested changes before approvals", () => {
    const requested = { ...openWith({ detailed_merge_status: "requested_changes" }), approvals: merged.approvals }
    expect(toPullRequest(requested).review).toBe("changesRequested")
  })

  test("needs an approver for approved, and has no review otherwise", () => {
    const noApprovers = {
      ...openWith({ detailed_merge_status: "mergeable" }),
      approvals: approvals({ approved: true, approved_by: [] }),
    }
    expect(toPullRequest(noApprovers).review).toBe(null)
    expect(toPullRequest(openWith({ detailed_merge_status: "mergeable" })).review).toBe(null)
  })

  test("reads conflicts and a merge status GitLab is still checking", () => {
    expect(toPullRequest(openWith({ has_conflicts: true })).mergeable).toBe("conflicting")
    for (const status of ["checking", "unchecked", "preparing"]) {
      expect(toPullRequest(openWith({ detailed_merge_status: status })).mergeable).toBe("unknown")
    }
  })

  test("has no checks without a pipeline", () => {
    expect(toPullRequest(openWith({ head_pipeline: null })).checks).toBe(null)
  })
})

describe("pipelineChecks", () => {
  test("maps every pipeline status", () => {
    expect(pipelineChecks("success")).toBe("passing")
    expect(pipelineChecks("failed")).toBe("failing")
    expect(pipelineChecks("canceled")).toBe("failing")
    expect(pipelineChecks("skipped")).toBe(null)
    expect(pipelineChecks("manual")).toBe(null)
    expect(pipelineChecks(undefined)).toBe(null)
    for (const status of ["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled"]) {
      expect(pipelineChecks(status)).toBe("pending")
    }
  })
})

describe("diffStat", () => {
  test("counts added and removed lines, not context or hunk headers", () => {
    expect(
      diffStat([{ diff: "@@ -1,3 +1,3 @@\n context\n---removed\n+++added\n+second\n\\ No newline at end of file\n" }]),
    ).toStrictEqual({
      additions: 2,
      deletions: 1,
    })
  })
})

describe("toCheckRuns", () => {
  test("lists one check per job with its log link, failing first", () => {
    const runs = toCheckRuns(
      jobs([
        ...fixtures.jobs4335.slice(0, 1),
        { name: "lint", status: "failed", allow_failure: false, web_url: "https://gitlab.com/j/1" },
        { name: "sast", status: "failed", allow_failure: true, web_url: "https://gitlab.com/j/2" },
        { name: "unit", status: "running", allow_failure: false, web_url: "https://gitlab.com/j/3" },
        { name: "deploy", status: "canceled", allow_failure: false, web_url: "https://gitlab.com/j/4" },
      ]),
    )
    expect(runs).toStrictEqual([
      { name: "lint", status: "failing", url: "https://gitlab.com/j/1" },
      { name: "deploy", status: "failing", url: "https://gitlab.com/j/4" },
      { name: "unit", status: "pending", url: "https://gitlab.com/j/3" },
      { name: "snapcraft_build_edge", status: "passing", url: fixtures.jobs4335[0]?.web_url },
      { name: "sast", status: "skipped", url: "https://gitlab.com/j/2" },
    ])
  })

  test("counts a manual job as skipped", () => {
    const govulncheck = toCheckRuns(jobs(fixtures.jobs4335)).find((run) => run.name === "govulncheck")
    expect(govulncheck?.status).toBe("skipped")
  })
})

describe("toPullRequestDetail", () => {
  const detail = toPullRequestDetail({
    ...open,
    changedFiles: 1,
    jobs: jobs(fixtures.jobs4344),
    notes: notes(fixtures.notes4344),
    viewer: "jay_mccure",
  })

  test("adds the description, refs, head commit, file count and jobs", () => {
    expect(detail).toMatchObject({
      url: OPEN_URL,
      body: fixtures.mergeRequest4344.description,
      baseRef: "main",
      headRef: "jmc-coverage-skip-on-test-failure",
      head: "428bf9b09b2ca16f92a9ac76781e12aa9fbebe61",
      changedFiles: 1,
    })
    expect(detail.checkRuns).toHaveLength(fixtures.jobs4344.length)
  })

  test("lists non-system notes, locating diff notes and telling who wrote them", () => {
    expect(detail.comments).toStrictEqual([
      {
        id: "2002",
        author: "reviewer",
        authorKind: "human",
        body: "Should this also skip on release schedules?",
        createdAt: "2026-11-08T11:00:00.000Z",
        url: `${OPEN_URL}#note_2002`,
        location: { path: ".gitlab-ci.yml", line: 443, side: "RIGHT" },
      },
      {
        id: "2003",
        author: "reviewer",
        authorKind: "human",
        body: "The old rule is gone now.",
        createdAt: "2026-11-08T11:05:00.000Z",
        url: `${OPEN_URL}#note_2003`,
        location: { path: ".gitlab-ci.yml", line: 440, side: "LEFT" },
      },
      {
        id: "2004",
        author: "jay_mccure",
        authorKind: "you",
        body: "Yes, it inherits the release rule.",
        createdAt: "2026-11-08T12:00:00.000Z",
        url: `${OPEN_URL}#note_2004`,
        location: null,
      },
      {
        id: "2005",
        author: "GitLabDuo",
        authorKind: "bot",
        body: "Code review summary",
        createdAt: "2026-11-08T12:30:00.000Z",
        url: `${OPEN_URL}#note_2005`,
        location: null,
      },
    ])
  })

  test("has an empty body when the description is null", () => {
    const withoutDescription = toPullRequestDetail({
      ...openWith({ description: null }),
      changedFiles: 1,
      jobs: [],
      notes: [],
      viewer: null,
    })
    expect(withoutDescription.body).toBe("")
  })
})

const failure = (exitCode: number, stderr: string) =>
  gitLabErrorOf("gitlab.example.com", new CommandError({ command: "glab", args: ["api"], exitCode, stderr }))

describe("gitLabErrorOf", () => {
  test("reads a missing binary, a signed-out host and an API message", () => {
    expect(failure(-1, "spawn glab ENOENT")).toStrictEqual(new GitLabCliMissingError())
    expect(failure(1, "glab: 401 Unauthorized (HTTP 401)")).toStrictEqual(
      new GitLabSignedOutError({ hostname: "gitlab.example.com" }),
    )
    expect(failure(1, "glab: 404 Not found (HTTP 404)")).toStrictEqual(new GitLabApiError({ detail: "404 Not found" }))
    expect(failure(1, "glab: HTTP 404")).toStrictEqual(new GitLabApiError({ detail: "HTTP 404" }))
  })

  test("keeps the command error when glab did not reach the API", () => {
    expect(failure(1, "dial tcp: no such host")._tag).toBe("CommandError")
  })
})

describe("mergeRequestUrlIn", () => {
  test("finds the merge request URL glab mr create prints", () => {
    const output =
      "\nCreating merge request for feature into main in group/project\n\n!42 Add a feature (feature)\n https://gitlab.example.com/group/project/-/merge_requests/42\n\n"
    expect(mergeRequestUrlIn(output)).toBe("https://gitlab.example.com/group/project/-/merge_requests/42")
    expect(mergeRequestUrlIn("nothing here")).toBe(undefined)
  })
})

interface GlabReply {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
}

const fakeGlab = (reply: (path: string) => GlabReply) => {
  const paths: Array<string> = []
  const spawner = ChildProcessSpawner.make((command) => {
    const path = command._tag === "StandardCommand" ? (command.args.at(-1) ?? "") : ""
    paths.push(path)
    const { stdout = "", stderr = "", exitCode = 0 } = reply(path)
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.make(new TextEncoder().encode(stderr)),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return {
    paths,
    layer: layer.pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      Layer.provide(Layer.succeed(Events, Events.of({ publish: () => Effect.void }))),
    ),
  }
}

const NETWORK_ERROR: GlabReply = { stderr: "dial tcp: lookup gitlab.example.com: no such host", exitCode: 1 }

const probeTwice = (replies: ReadonlyArray<GlabReply>) => {
  const glab = fakeGlab(() => replies[glab.paths.length - 1] ?? {})
  return GitLab.use((gitlab) =>
    Effect.gen(function* () {
      const first = yield* gitlab.isGitLabHost("gitlab.example.com")
      const second = yield* gitlab.isGitLabHost("gitlab.example.com")
      return { answers: [first, second], probes: glab.paths.length }
    }),
  ).pipe(Effect.provide(glab.layer))
}

describe("isGitLabHost", () => {
  it.effect("probes again after glab could not reach the host", () =>
    Effect.gen(function* () {
      expect(yield* probeTwice([NETWORK_ERROR, { stdout: "{}" }])).toStrictEqual({ answers: [false, true], probes: 2 })
    }),
  )

  it.effect("probes again after glab was missing", () =>
    Effect.gen(function* () {
      expect(yield* probeTwice([{ exitCode: -1 }, { stdout: "{}" }])).toStrictEqual({
        answers: [false, true],
        probes: 2,
      })
    }),
  )

  it.effect("remembers a host whose API refused the probe", () =>
    Effect.gen(function* () {
      expect(yield* probeTwice([{ stderr: "glab: 404 Not found (HTTP 404)", exitCode: 1 }])).toStrictEqual({
        answers: [false, false],
        probes: 1,
      })
    }),
  )

  it.effect("remembers a host glab is signed out of", () =>
    Effect.gen(function* () {
      expect(yield* probeTwice([{ stderr: "glab: 401 Unauthorized (HTTP 401)", exitCode: 1 }])).toStrictEqual({
        answers: [true, true],
        probes: 1,
      })
    }),
  )
})

const json = (value: unknown): GlabReply => ({ stdout: JSON.stringify(value) })

const mergeRequest4344Reply = (path: string, userReply: () => GlabReply): GlabReply => {
  if (path === "user") return userReply()
  if (path.endsWith("/approvals")) return json(fixtures.approvals4344)
  if (path.includes("/diffs?")) return { stdout: `HTTP/1.1 200 OK\r\n\r\n${JSON.stringify(fixtures.diffs4344)}` }
  if (path.includes("/notes?")) return json(fixtures.notes4344)
  if (path.includes("/jobs?")) return json(fixtures.jobs4344)
  return json(fixtures.mergeRequest4344)
}

describe("pullRequestDetail", () => {
  it.effect("asks who the viewer is again after the lookup failed", () =>
    Effect.gen(function* () {
      const userReplies = [NETWORK_ERROR, json({ username: "jay_mccure" })]
      const glab = fakeGlab((path) => mergeRequest4344Reply(path, () => userReplies.shift() ?? {}))
      const yours = yield* GitLab.use((gitlab) =>
        Effect.all([gitlab.pullRequestDetail(OPEN_URL), gitlab.pullRequestDetail(OPEN_URL)]),
      ).pipe(
        Effect.map((details) =>
          details.map((detail) => detail.comments.filter((comment) => comment.authorKind === "you").length),
        ),
        Effect.provide(glab.layer),
      )
      expect(yours[0]).toBe(0)
      expect(yours[1]).toBeGreaterThan(0)
    }),
  )
})
