import { useAtomValue } from "@effect/atom-react"
import { XCircleIcon, CheckCircleIcon, CircleIcon } from "@hinacode/icons"
import { Effect, Schema } from "effect"
import { Atom, AsyncResult } from "effect/reactivity"
import { type FormEvent, useId, useState, useTransition } from "react"
import { toast } from "sonner"
import {
  type Artifact,
  currentVerdict,
  type Verdict,
  type VerdictDecision,
  type VerifyPane,
  VerifySpec,
} from "../../../shared/artifact.ts"
import { artifactUrl } from "../../../shared/channels.ts"
import { useArtifactTheme } from "../../lib/artifactTheme.ts"
import { textOfDataUrl } from "../../lib/dataUrl.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { resourceUrl, servedSandbox } from "../../lib/resourceUrl.ts"
import { artifactsAtom, call, documentAtom, type EnvironmentId, familyOf } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { useArtifacts } from "../../stores/artifacts.ts"
import { type FeedbackActions, loadedFeedback, useFeedback, useFeedbackActions } from "../artifactComments/feedback.ts"
import { Markdown } from "../Markdown.tsx"
import { Button } from "../ui/button.tsx"
import { ScrollArea } from "../ui/scroll-area.tsx"
import { Textarea } from "../ui/textarea.tsx"
import { ArtifactKindIcon } from "./ArtifactKindIcon.tsx"

const decodeSpec = Schema.decodeUnknownEffect(Schema.fromJsonString(VerifySpec))

const verifySpecAtom = familyOf((environment: EnvironmentId, id: string, entry: string, _version: number) =>
  Atom.make(
    call("artifacts.file", { id, path: entry }, { environment }).pipe(
      Effect.flatMap(({ dataUrl }) => decodeSpec(textOfDataUrl(dataUrl))),
    ),
  ),
)

const noArtifacts: ReadonlyArray<Artifact> = []

const focusOnMount = (element: HTMLElement | null) => element?.focus()

const failed = (message: string) => (
  <p role="alert" className="p-4 text-xs wrap-anywhere text-destructive">
    {m.verify_load_failed({ message })}
  </p>
)

export function VerifyView({ threadId, artifact }: { threadId: string; artifact: Artifact }) {
  const environment = artifact.environmentId ?? null
  const spec = useAtomValue(verifySpecAtom(environment, artifact.id, artifact.entry, artifact.version))
  const feedback = loadedFeedback(useFeedback(artifact))
  const actions = useFeedbackActions(artifact)
  return (
    <div className="@container flex min-h-0 flex-1 flex-col transition-opacity duration-200 ease-out starting:opacity-0">
      <ScrollArea className="min-h-0 flex-1">
        {AsyncResult.builder(spec)
          .onInitial(() => <p className="animate-reveal p-4 text-xs text-muted-foreground">{m.verify_loading()}</p>)
          .onSuccess((loaded) => (
            <div className="flex flex-col gap-4 p-4">
              {loaded.notes !== undefined && loaded.notes !== "" && (
                <Markdown text={loaded.notes} className="text-sm" />
              )}
              <div className="grid gap-4 @2xl:grid-cols-2">
                <PaneColumn
                  title={m.verify_expected()}
                  threadId={threadId}
                  artifact={artifact}
                  panes={loaded.expected}
                />
                <PaneColumn title={m.verify_actual()} threadId={threadId} artifact={artifact} panes={loaded.actual} />
              </div>
            </div>
          ))
          .onError((error) => failed(errorMessage(error)))
          .orElse(() => failed(""))}
      </ScrollArea>
      <VerdictBar key={artifact.version} verdict={currentVerdict(feedback, artifact.version)} actions={actions} />
    </div>
  )
}

function PaneColumn({
  title,
  threadId,
  artifact,
  panes,
}: {
  title: string
  threadId: string
  artifact: Artifact
  panes: ReadonlyArray<VerifyPane>
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <h3 id={headingId} className="text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      {panes.length === 0 && <p className="text-xs text-muted-foreground">{m.verify_empty()}</p>}
      {panes.map((pane, index) => (
        <figure key={index} className="flex min-w-0 flex-col gap-1.5">
          {"path" in pane ? (
            <FilePane artifact={artifact} path={pane.path} label={pane.label} />
          ) : (
            <ReferencedArtifact threadId={threadId} id={pane.artifactId} environmentId={artifact.environmentId} />
          )}
          {pane.label !== undefined && <figcaption className="text-xs text-muted-foreground">{pane.label}</figcaption>}
        </figure>
      ))}
    </section>
  )
}

const VIDEO_EXTENSION = /\.(mp4|webm|mov|m4v|ogv)$/i

const mediaFrame = "w-full rounded-md border border-border bg-muted/40"

function FilePane({ artifact, path, label }: { artifact: Artifact; path: string; label: string | undefined }) {
  const type = artifact.files.find((file) => file.path === path)?.type ?? ""
  const src = resourceUrl(`${artifactUrl(artifact.id, path)}?v=${artifact.version}`)
  if (type.startsWith("video/") || VIDEO_EXTENSION.test(path))
    return (
      // oxlint-disable-next-line jsx-a11y/media-has-caption -- an agent's screen recording carries no caption track.
      <video src={src} controls preload="metadata" aria-label={label ?? path} className={mediaFrame} />
    )
  return <img src={src} alt={label ?? path} loading="lazy" className={mediaFrame} />
}

function ReferencedArtifact({
  threadId,
  id,
  environmentId,
}: {
  threadId: string
  id: string
  environmentId: string | undefined
}) {
  const artifacts = AsyncResult.getOrElse(useAtomValue(artifactsAtom), () => noArtifacts)
  const select = useArtifacts((state) => state.select)
  const theme = useArtifactTheme()
  const found = artifacts.find((artifact) => artifact.id === id && artifact.environmentId === environmentId)
  if (found === undefined) return <p className="text-xs text-muted-foreground">{m.verify_missing_artifact({ id })}</p>
  if (found.kind === undefined || found.kind === "page")
    return (
      <iframe
        src={resourceUrl(`${artifactUrl(found.id, found.entry)}?v=${found.version}&theme=${encodeURIComponent(theme)}`)}
        title={found.title}
        sandbox={servedSandbox()}
        referrerPolicy="no-referrer"
        className={`${mediaFrame} aspect-4/3 bg-background`}
      />
    )
  if (found.kind === "document") return <ReferencedDocument artifact={found} />
  return (
    <button
      type="button"
      onClick={() => select(threadId, found.id)}
      aria-label={m.artifact_open({ title: found.title })}
      className="flex min-w-0 items-center gap-2 rounded-md border border-border px-3 py-2 text-start text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArtifactKindIcon artifact={found} className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-artifact-title">{found.title}</span>
    </button>
  )
}

function ReferencedDocument({ artifact }: { artifact: Artifact }) {
  const content = useAtomValue(documentAtom(artifact.environmentId ?? null, artifact.id))
  return (
    <div className="max-h-96 overflow-y-auto rounded-md border border-border px-4 py-3">
      {AsyncResult.builder(content)
        .onInitial(() => <p className="text-xs text-muted-foreground">{m.documents_loading()}</p>)
        .onSuccess((loaded) => <Markdown text={loaded.markdown} className="text-sm" />)
        .onError((error) => (
          <p className="text-xs text-destructive">{m.documents_load_failed({ message: errorMessage(error) })}</p>
        ))
        .orElse(() => null)}
    </div>
  )
}

function VerdictStatus({ verdict }: { verdict: Verdict | null }) {
  if (verdict === null)
    return (
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
        <CircleIcon aria-hidden className="size-3.5 shrink-0" />
        {m.verify_pending()}
      </p>
    )
  if (verdict.decision === "pass")
    return (
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-success">
        <CheckCircleIcon aria-hidden className="size-3.5 shrink-0" />
        {m.verify_passed()}
      </p>
    )
  const text = m.verify_rejected({ reason: verdict.reason })
  return (
    <p title={text} className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-destructive">
      <XCircleIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{text}</span>
    </p>
  )
}

function VerdictBar({ verdict, actions }: { verdict: Verdict | null; actions: FeedbackActions }) {
  const reasonId = useId()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState("")
  const [deciding, startDeciding] = useTransition()

  const decide = (decision: VerdictDecision, why: string) =>
    startDeciding(async () => {
      try {
        await actions.decide(decision, why)
        setRejecting(false)
        setReason("")
      } catch (cause) {
        toast.error(m.verify_decide_failed({ message: errorMessage(cause) }))
      }
    })

  const submitRejection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (reason.trim() !== "") decide("reject", reason.trim())
  }

  return (
    <div className="shrink-0 border-t border-border">
      {rejecting && (
        <form
          aria-labelledby={`${reasonId}-label`}
          onSubmit={submitRejection}
          className="flex flex-col gap-2 border-b border-border p-3"
        >
          <label id={`${reasonId}-label`} htmlFor={reasonId} className="text-xs font-medium">
            {m.verify_reason()}
          </label>
          <Textarea
            id={reasonId}
            ref={focusOnMount}
            required
            value={reason}
            placeholder={m.verify_reason_placeholder()}
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              event.stopPropagation()
              setRejecting(false)
            }}
            className="max-h-40 text-sm"
          />
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="xs" action={() => setRejecting(false)}>
              {m.common_cancel()}
            </Button>
            <Button type="submit" variant="destructive" size="xs" disabled={deciding}>
              {m.verify_reject()}
            </Button>
          </div>
        </form>
      )}
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
        <VerdictStatus verdict={verdict} />
        <div className="flex shrink-0 gap-1.5">
          <Button
            variant="outline"
            size="xs"
            aria-pressed={verdict?.decision === "reject"}
            aria-expanded={rejecting}
            disabled={deciding}
            action={() => setRejecting(true)}
          >
            {m.verify_reject()}
          </Button>
          <Button
            size="xs"
            aria-pressed={verdict?.decision === "pass"}
            disabled={deciding}
            onClick={() => decide("pass", "")}
          >
            {m.verify_pass()}
          </Button>
        </div>
      </div>
    </div>
  )
}
