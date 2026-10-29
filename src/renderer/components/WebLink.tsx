import { useAtomValue } from "@effect/atom-react"
import { useParams } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { createContext, type ReactNode, useContext } from "react"
import { RiGlobalLine } from "react-icons/ri"
import { parsePullRequestUrl, pullRequestLabel } from "../lib/pullRequestRefs.ts"
import { usePullRequestHref } from "../lib/environments.ts"
import { faviconAtom } from "../lib/rpc.ts"
import { useThreadRepository } from "../lib/threadRepository.ts"
import { WithLinkIcon } from "./LinkIcon.tsx"
import { PullRequestLink } from "./PullRequestLink.tsx"

export const isWebUrl = (href: string | undefined): href is string => /^https?:\/\//i.test(href ?? "")

const originOf = (href: string) => URL.parse(href)?.origin ?? ""

export const FaviconOrigins = createContext<ReadonlySet<string>>(new Set())

const placeholder = <RiGlobalLine className="block size-full text-muted-foreground" />

function Favicon({ origin }: { origin: string }) {
  return useContext(FaviconOrigins).has(origin) ? <FetchedFavicon origin={origin} /> : placeholder
}

function FetchedFavicon({ origin }: { origin: string }) {
  const icon = AsyncResult.getOrElse(useAtomValue(faviconAtom(origin)), () => null)
  return icon ? (
    <img
      src={icon}
      alt=""
      loading="lazy"
      draggable={false}
      className="block size-full rounded-sm p-[calc(1em/12)] select-none"
    />
  ) : (
    placeholder
  )
}

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
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      <WithLinkIcon icon={<Favicon origin={originOf(href)} />}>{label}</WithLinkIcon>
    </a>
  )
}
