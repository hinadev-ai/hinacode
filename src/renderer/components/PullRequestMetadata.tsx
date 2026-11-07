import { Combobox } from "@base-ui/react/combobox"
import { useAtomValue } from "@effect/atom-react"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useId, useOptimistic, useState, useTransition } from "react"
import type {
  PullRequestCandidates,
  PullRequestDetail,
  PullRequestEditField,
  PullRequestLabel,
  ReviewerState,
} from "../../shared/domain.ts"
import { externalImageUrl } from "../../shared/channels.ts"
import { useOpenThreadEnvironment } from "../lib/environments.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { resourceUrl } from "../lib/resourceUrl.ts"
import { callPromise, gitHubAuthAtom, pullRequestCandidatesAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { Input } from "./ui/input.tsx"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx"
import { SkeletonList } from "./ui/skeleton.tsx"
import { ChatIcon, CheckCircleIcon, CheckIcon, HourglassIcon, type IconComponent, XCircleIcon } from "@hinacode/icons"

const reviewerIndicator = {
  requested: { Icon: HourglassIcon, className: "text-muted-foreground", label: m.pr_reviewer_requested },
  approved: { Icon: CheckCircleIcon, className: "text-success", label: m.pr_reviewer_approved },
  changesRequested: { Icon: XCircleIcon, className: "text-destructive", label: m.pr_reviewer_changes_requested },
  commented: { Icon: ChatIcon, className: "text-muted-foreground", label: m.pr_reviewer_commented },
} satisfies Record<ReviewerState, { Icon: IconComponent; className: string; label: () => string }>

export function PullRequestMetadata({ pullRequest }: { pullRequest: PullRequestDetail }) {
  const requested = pullRequest.reviewers.filter((reviewer) => reviewer.state === "requested")
  const reviewed = pullRequest.reviewers.filter((reviewer) => reviewer.state !== "requested")
  const knownLabels = new Map(pullRequest.labels.map((label) => [label.name, label]))
  const labelNamed = (name: string, candidates?: PullRequestCandidates) =>
    candidates?.labels.find((label) => label.name === name) ?? knownLabels.get(name) ?? { name, color: "" }

  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 text-xs">
      <MetadataRow
        url={pullRequest.url}
        field="reviewers"
        title={m.pr_reviewers()}
        selected={requested.map((reviewer) => reviewer.login)}
        candidates={({ users }) => users.filter((login) => login !== pullRequest.author)}
        renderOption={(login) => <Person login={login} />}
        renderValues={(logins) => {
          const asked = new Set(logins)
          return [
            ...logins.map((login) => <Reviewer key={login} login={login} state="requested" />),
            ...reviewed
              .filter((reviewer) => !asked.has(reviewer.login))
              .map((reviewer) => <Reviewer key={reviewer.login} login={reviewer.login} state={reviewer.state} />),
          ]
        }}
      />
      <MetadataRow
        url={pullRequest.url}
        field="assignees"
        title={m.pr_assignees()}
        selected={pullRequest.assignees}
        candidates={({ users }) => users}
        renderOption={(login) => <Person login={login} />}
        renderValues={(logins) => logins.map((login) => <Person key={login} login={login} />)}
      />
      <MetadataRow
        url={pullRequest.url}
        field="labels"
        title={m.pr_labels()}
        selected={pullRequest.labels.map((label) => label.name)}
        candidates={({ labels }) => labels.map((label) => label.name)}
        renderOption={(name, candidates) => <Label label={labelNamed(name, candidates)} />}
        renderValues={(names) =>
          names.map((name) => (
            <Label key={name} label={labelNamed(name)} className="rounded-full border border-border px-1.5 py-px" />
          ))
        }
      />
    </dl>
  )
}

interface MetadataRowProps {
  readonly url: string
  readonly field: PullRequestEditField
  readonly title: string
  readonly selected: ReadonlyArray<string>
  readonly candidates: (candidates: PullRequestCandidates) => ReadonlyArray<string>
  readonly renderOption: (value: string, candidates: PullRequestCandidates) => ReactNode
  readonly renderValues: (values: ReadonlyArray<string>) => ReadonlyArray<ReactNode>
}

function MetadataRow({ url, field, title, selected, candidates, renderOption, renderValues }: MetadataRowProps) {
  const environment = useOpenThreadEnvironment()
  const signedIn = AsyncResult.getOrElse(useAtomValue(gitHubAuthAtom(environment)), () => null)?.type === "signedIn"
  const [values, showValues] = useOptimistic(selected)
  const [, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const valuesId = useId()
  const shown = renderValues(values)

  const save = (next: ReadonlyArray<string>) =>
    startTransition(async () => {
      setError(null)
      showValues(next)
      const before = new Set(selected)
      const after = new Set(next)
      const add = next.filter((value) => !before.has(value))
      const remove = selected.filter((value) => !after.has(value))
      try {
        await callPromise("github.editPullRequest", { url, edit: { field, add, remove } }, { environment })
      } catch (cause) {
        setError(m.pr_meta_save_failed({ message: errorMessage(cause) }))
      }
    })

  return (
    <>
      <dt id={titleId} className="py-1 text-muted-foreground">
        {title}
      </dt>
      <dd className="flex min-w-0 flex-col gap-1">
        <Popover>
          <PopoverTrigger
            disabled={!signedIn}
            aria-labelledby={`${titleId} ${valuesId}`}
            className="-mx-1.5 flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1.5 py-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring hover:enabled:bg-muted/50"
          >
            <span id={valuesId} className="contents">
              {shown.length === 0 ? <span className="text-muted-foreground">{m.pr_meta_none()}</span> : shown}
            </span>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 gap-1.5 p-1.5">
            <MetadataPicker
              url={url}
              title={title}
              values={values}
              candidates={candidates}
              renderOption={renderOption}
              onChange={save}
            />
          </PopoverContent>
        </Popover>
        {error && (
          <p role="alert" className="text-xs wrap-anywhere text-destructive">
            {error}
          </p>
        )}
      </dd>
    </>
  )
}

interface MetadataPickerProps {
  readonly url: string
  readonly title: string
  readonly values: ReadonlyArray<string>
  readonly candidates: MetadataRowProps["candidates"]
  readonly renderOption: MetadataRowProps["renderOption"]
  readonly onChange: (values: ReadonlyArray<string>) => void
}

function MetadataPicker({ url, title, values, candidates, renderOption, onChange }: MetadataPickerProps) {
  const environment = useOpenThreadEnvironment()
  const result = useAtomValue(pullRequestCandidatesAtom(environment, url))

  const loaded = AsyncResult.isSuccess(result) ? result.value : null
  const offered = loaded === null ? [] : candidates(loaded)
  const items = [...new Set([...offered, ...values])]

  return (
    <Combobox.Root
      inline
      open
      multiple
      autoHighlight
      items={items}
      value={[...values]}
      onValueChange={(next: Array<string>) => onChange(next)}
    >
      <Combobox.Input
        aria-label={title}
        placeholder={m.pr_meta_search()}
        spellCheck={false}
        render={<Input className="h-7 shrink-0 text-xs" />}
      />
      {AsyncResult.isFailure(result) ? (
        <p role="alert" className="p-1 text-xs wrap-anywhere text-destructive">
          {m.pr_meta_options_failed({ message: errorMessage(Cause.squash(result.cause)) })}
        </p>
      ) : loaded === null ? (
        <SkeletonList label={m.pr_meta_loading()} rows={3} rowClassName="h-4" className="p-1" />
      ) : (
        <>
          <Combobox.List
            aria-label={title}
            className="flex max-h-64 scroll-fade-y scroll-py-1 flex-col gap-0.5 overflow-y-auto overscroll-contain"
          >
            {(value: string) => (
              <Combobox.Item
                key={value}
                value={value}
                className="group flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs outline-none select-none data-highlighted:bg-accent"
              >
                <span className="flex min-w-0 flex-1">{renderOption(value, loaded)}</span>
                <CheckIcon aria-hidden className="invisible size-3.5 shrink-0 group-aria-selected:visible" />
              </Combobox.Item>
            )}
          </Combobox.List>
          <Combobox.Empty className="px-2 py-1 text-xs text-muted-foreground empty:hidden">
            {m.pr_meta_no_match()}
          </Combobox.Empty>
        </>
      )}
    </Combobox.Root>
  )
}

function Reviewer({ login, state }: { login: string; state: ReviewerState }) {
  const { Icon, className, label } = reviewerIndicator[state]
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Person login={login} />
      <Icon aria-label={label()} className={cn("size-3.5 shrink-0", className)} />
    </span>
  )
}

function Person({ login }: { login: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Avatar login={login} />
      <span className="truncate">{login}</span>
    </span>
  )
}

function Label({ label, className }: { label: PullRequestLabel; className?: string }) {
  return (
    <span className={cn("flex max-w-full min-w-0 items-center gap-1.5", className)}>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full bg-muted-foreground"
        style={label.color === "" ? undefined : { backgroundColor: `#${label.color}` }}
      />
      <span className="truncate">{label.name}</span>
    </span>
  )
}

export function Avatar({ login }: { login: string }) {
  const [failed, setFailed] = useState(false)
  const external = externalImageUrl(`https://github.com/${login}.png?size=48`)
  const src = external === null ? null : resourceUrl(external)
  if (failed || src === null) {
    return (
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[0.5625rem] font-medium uppercase"
      >
        {login.slice(0, 1)}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt=""
      className="size-4 shrink-0 rounded-full bg-muted outline-1 -outline-offset-1 outline-white/10"
      onError={() => setFailed(true)}
    />
  )
}
