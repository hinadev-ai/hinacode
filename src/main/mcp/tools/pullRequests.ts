import { Effect, Schema } from "effect"
import { Toolkit } from "effect/ai"
import { WatchEventKind } from "../../../shared/domain.ts"
import { PullRequests } from "../../services/PullRequests.ts"
import * as McpTool from "./tool.ts"

const PullRequestUrl = Schema.String.annotate({
  description: "GitHub pull request URL, for example https://github.com/owner/repo/pull/123",
})

export const PullRequestTools = Toolkit.make(
  McpTool.make("link_pull_request", {
    description:
      "Register a GitHub pull request you opened for this thread so the user sees it next to the thread. Call it right after creating the PR.",
    parameters: Schema.Struct({ url: PullRequestUrl }),
  }),
  McpTool.make("list_thread_pull_requests", {
    description: "List the pull requests linked to this thread, marking the ones this thread is watching.",
  }),
  McpTool.make("unlink_pull_request", {
    description: "Remove a pull request link from this thread. A watch on it ends with the link.",
    parameters: Schema.Struct({ url: PullRequestUrl }),
  }),
  McpTool.make("watch_pull_request", {
    description:
      "Watch a pull request for this thread instead of polling it yourself. KKCode checks it every minute and sends this thread a new message when something you care about changes, so end your turn after calling this. The watch ends on its own when the pull request merges or closes. Links the pull request first when it is not linked yet.",
    parameters: Schema.Struct({
      url: PullRequestUrl,
      events: Schema.optionalKey(
        Schema.Array(WatchEventKind).annotate({
          description:
            "What to be woken for. Defaults to all of checksFailed, checksPassed, reviewChanged, conflicting and mergedOrClosed.",
        }),
      ),
    }),
  }),
  McpTool.make("unwatch_pull_request", {
    description: "Stop watching a pull request for this thread. The link itself stays.",
    parameters: Schema.Struct({ url: PullRequestUrl }),
  }),
)

export const pullRequestToolsLayer = PullRequestTools.toLayer(
  Effect.gen(function* () {
    const pullRequests = yield* PullRequests
    return PullRequestTools.of({
      link_pull_request: ({ url }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.map(pullRequests.link(threadId, url), (canonical) => `Linked ${canonical} to this thread.`),
        ),
      list_thread_pull_requests: () =>
        McpTool.CallingThread.use((threadId) =>
          Effect.map(pullRequests.list(threadId), (links) =>
            links.length === 0
              ? "No pull requests are linked to this thread."
              : links
                  .map((link) =>
                    link.watch === null
                      ? `- ${link.url}`
                      : `- ${link.url} (watching for ${link.watch.events.join(", ")}; ${link.watch.wakes} ${link.watch.wakes === 1 ? "wake" : "wakes"})`,
                  )
                  .join("\n"),
          ),
        ),
      unlink_pull_request: ({ url }) =>
        McpTool.CallingThread.use((threadId) => Effect.as(pullRequests.unlink(threadId, url), `Unlinked ${url}.`)),
      watch_pull_request: ({ url, events: kinds }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.map(
            pullRequests.watch(threadId, url, kinds ?? []),
            (link) =>
              `Watching ${link.url} for ${link.watch?.events.join(", ") ?? ""}. KKCode checks it every minute and will send this thread a message when one of those changes. Do not poll for it.`,
          ),
        ),
      unwatch_pull_request: ({ url }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.as(pullRequests.unwatch(threadId, url), `Stopped watching ${url}.`),
        ),
    })
  }),
)
