import { useAtomValue } from "@effect/atom-react"
import { useParams } from "@tanstack/react-router"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { createContext, type ReactNode, useContext } from "react"
import {
  issueUrl,
  parseIssueUrl,
  parsePullRequestUrl,
  type PullRequestRef,
  pullRequestLabel,
} from "../lib/pullRequestRefs.ts"
import { useOpenThreadEnvironment, usePullRequestHref } from "../lib/environments.ts"
import { faviconAtom, issueAtom, pullRequestStatusAtom } from "../lib/rpc.ts"
import { useThreadRepository } from "../lib/threadRepository.ts"
import { WithLinkIcon } from "./LinkIcon.tsx"
import { PullRequestLink } from "./PullRequestLink.tsx"
import { GlobeIcon } from "@hinacode/icons"

export const isWebUrl = (href: string | undefined): href is string => /^https?:\/\//i.test(href ?? "")

const originOf = (href: string) => URL.parse(href)?.origin ?? ""

export const FaviconOrigins = createContext<ReadonlySet<string>>(new Set())

const placeholder = <GlobeIcon className="block size-full text-muted-foreground" />

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
  const issue = pullRequest ? null : parseIssueUrl(href)
  const reference = pullRequest ?? issue
  if (reference) {
    return (
      <PullRequestLink href={pullRequestHref} pullRequest={reference} issue={issue !== null}>
        {children === href ? pullRequestLabel(reference, repository) : children}
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

const isMissing = (lookup: AsyncResult.AsyncResult<unknown, unknown>) =>
  AsyncResult.isFailure(lookup) && Option.isNone(AsyncResult.value(lookup))

export function PullRequestReference({ href, children }: { href: string; children: ReactNode }) {
  const status = useAtomValue(pullRequestStatusAtom(useOpenThreadEnvironment(), href))
  const reference = parsePullRequestUrl(href)
  if (!isMissing(status)) return <WebLink href={href}>{children}</WebLink>
  return reference ? <IssueReference reference={reference}>{children}</IssueReference> : children
}

function IssueReference({ reference, children }: { reference: PullRequestRef; children: ReactNode }) {
  const href = issueUrl(reference)
  const status = useAtomValue(issueAtom(useOpenThreadEnvironment(), href))
  return isMissing(status) ? children : <WebLink href={href}>{children}</WebLink>
}
