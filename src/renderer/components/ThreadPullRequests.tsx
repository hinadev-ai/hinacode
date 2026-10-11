import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import { AsyncResult } from "effect/reactivity"
import { useState, useTransition } from "react"
import { RiExternalLinkLine, RiGitPullRequestLine, RiLinkUnlinkM } from "react-icons/ri"
import type { PullRequestLink } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { loadPullRequestsAtom, usePullRequests } from "../stores/pullRequests.ts"
import { Button } from "./ui/button.tsx"
import { SkeletonList } from "./ui/skeleton.tsx"

/** "owner/repo#123" for a canonical GitHub pull request URL. */
const shortName = (url: string) => {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url)
  return match ? `${match[1]}#${match[2]}` : url
}

/** Pull requests agents linked to the thread, as the body of a panel section. Updates live. */
export function ThreadPullRequests({ threadId }: { threadId: string }) {
  const loadAtom = loadPullRequestsAtom(threadId)
  const load = useAtomValue(loadAtom)
  const reload = useAtomRefresh(loadAtom)
  const links = usePullRequests((state) => state.byThreadId[threadId])
  const [unlinkError, setUnlinkError] = useState<string | null>(null)
  const [listRef] = useAutoAnimate<HTMLUListElement>({ duration: 150 })

  if (!links) {
    return AsyncResult.builder(load)
      .onError((error) => (
        <div role="alert" className="flex items-center gap-2">
          <p className="text-xs text-destructive">{m.pr_links_failed({ message: errorMessage(error) })}</p>
          <Button variant="outline" size="xs" onClick={reload}>
            {m.common_retry()}
          </Button>
        </div>
      ))
      .orElse(() => <SkeletonList label={m.pr_links_loading()} rows={1} rowClassName="h-4" />)
  }

  return (
    <div className="flex flex-col gap-1.5">
      {links.length === 0 ? (
        <p className="text-xs text-muted-foreground">{m.pr_links_empty()}</p>
      ) : (
        <ul ref={listRef} className="flex flex-col">
          {links.map((link) => (
            <PullRequestRow key={link.id} link={link} onUnlinkFailed={setUnlinkError} />
          ))}
        </ul>
      )}
      {unlinkError && (
        <p role="alert" className="text-xs text-destructive">
          {unlinkError}
        </p>
      )}
    </div>
  )
}

interface PullRequestRowProps {
  readonly link: PullRequestLink
  readonly onUnlinkFailed: (message: string | null) => void
}

function PullRequestRow({ link, onUnlinkFailed }: PullRequestRowProps) {
  const [pending, startTransition] = useTransition()
  const name = shortName(link.url)

  // The row disappears when main pushes the updated list, so success needs no handling here.
  const unlink = () =>
    startTransition(async () => {
      try {
        await callPromise("pullRequests.unlink", { threadId: link.threadId, url: link.url })
        onUnlinkFailed(null)
      } catch (cause) {
        onUnlinkFailed(errorMessage(cause))
      }
    })

  return (
    <li className="flex items-center gap-2 py-0.5 text-xs">
      <RiGitPullRequestLine aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <a
        href={link.url}
        target="_blank"
        rel="noreferrer"
        title={link.url}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-sm font-mono underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="truncate">{name}</span>
        <RiExternalLinkLine aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      </a>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={m.pr_links_unlink({ name })}
        title={m.pr_links_unlink({ name })}
        disabled={pending}
        onClick={unlink}
      >
        <RiLinkUnlinkM aria-hidden />
      </Button>
    </li>
  )
}
