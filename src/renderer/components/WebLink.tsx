import { useAtomValue } from "@effect/atom-react"
import { useParams } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { createContext, type ReactNode, useContext } from "react"
import { RiGlobalLine } from "react-icons/ri"
import { parsePullRequestUrl, pullRequestLabel } from "../lib/pullRequestRefs.ts"
import { usePullRequestHref } from "../lib/environments.ts"
import { faviconAtom } from "../lib/rpc.ts"
import { useThreadRepository } from "../lib/threadRepository.ts"
import { PullRequestLink } from "./PullRequestLink.tsx"

/** Whether `href` is a web url, the only kind that gets a favicon. */
export const isWebUrl = (href: string | undefined): href is string => /^https?:\/\//i.test(href ?? "")

const originOf = (href: string) => URL.parse(href)?.origin ?? ""

/**
 * The sites the surrounding message may ask favicons for (see `faviconOrigins`). Links to any other
 * site keep the placeholder and never ask main. Empty outside a message.
 */
export const FaviconOrigins = createContext<ReadonlySet<string>>(new Set())

// Same size as the favicon, so the text does not shift when the icon arrives.
const placeholder = (
  <RiGlobalLine aria-hidden className="mr-1 inline-block size-3.5 align-[-0.125em] text-muted-foreground" />
)

function Favicon({ origin }: { origin: string }) {
  return useContext(FaviconOrigins).has(origin) ? <FetchedFavicon origin={origin} /> : placeholder
}

function FetchedFavicon({ origin }: { origin: string }) {
  const icon = AsyncResult.getOrElse(useAtomValue(faviconAtom(origin)), () => null)
  return icon ? (
    <img src={icon} alt="" aria-hidden className="mr-1 inline-block size-3.5 rounded-sm align-[-0.125em]" />
  ) : (
    placeholder
  )
}

/**
 * A link that opens in the system browser with its site's favicon in front. A bare url (text equal to
 * its href) is shown without a trailing slash. A GitHub pull request gets the GitHub mark, a hover card,
 * and a short name when its text is bare: `#n` in the thread's repository, `owner/repo#n` elsewhere.
 */
export function WebLink({ href, children }: { href: string; children: ReactNode }) {
  const repository = useThreadRepository()
  const { threadId } = useParams({ strict: false })
  const pullRequestHref = usePullRequestHref(threadId, href)
  const pullRequest = parsePullRequestUrl(href)
  if (pullRequest) {
    return (
      <PullRequestLink href={pullRequestHref} pullRequest={pullRequest}>
        {children === href ? pullRequestLabel(pullRequest, repository) : children}
      </PullRequestLink>
    )
  }
  const label = children === href ? href.replace(/\/$/, "") : children
  return (
    // target=_blank routes the click through the main process, which opens it in the system browser.
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      <Favicon origin={originOf(href)} />
      {label}
    </a>
  )
}
