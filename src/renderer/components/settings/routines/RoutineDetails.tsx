import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useId, useState, useTransition } from "react"
import type { Routine, RoutineRun } from "../../../../shared/domain.ts"
import { errorMessage } from "../../../lib/errorMessage.ts"
import { type EnvironmentId, callPromise, routineRunsAtom, routineWebhookAtom } from "../../../lib/rpc.ts"
import { m } from "../../../paraglide/messages.js"
import { CopyButton } from "../../CopyButton.tsx"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../ui/alert-dialog.tsx"
import { Button } from "../../ui/button.tsx"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog.tsx"
import { Field, FieldError, FieldLabel } from "../../ui/field.tsx"
import { SkeletonList } from "../../ui/skeleton.tsx"
import { CopyField } from "../CopyField.tsx"
import { formatTime, RunStatusBadge, runSourceLabel } from "./shared.tsx"

interface RoutineDetailsProps {
  readonly routine: Routine
  readonly environment: EnvironmentId
  readonly machine: string
}

export function RoutineDetails({ routine, environment, machine }: RoutineDetailsProps) {
  return (
    <div className="flex flex-col gap-5 pb-2">
      <Webhook routineId={routine.id} environment={environment} machine={machine} />
      <RecentRuns routineId={routine.id} />
    </div>
  )
}

const curlExample = (url: string) =>
  [
    `curl -X POST '${url}' \\`,
    `  -H "Authorization: Bearer $HINACODE_WEBHOOK_SECRET" \\`,
    `  --data 'Extra context'`,
  ].join("\n")

function Webhook({
  routineId,
  environment,
  machine,
}: {
  routineId: string
  environment: EnvironmentId
  machine: string
}) {
  const id = useId()
  const result = useAtomValue(routineWebhookAtom(environment, routineId))
  const refresh = useAtomRefresh(routineWebhookAtom(environment, routineId))
  const [secret, setSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const rotate = () =>
    startTransition(async () => {
      setError(null)
      try {
        const rotated = await callPromise("routines.rotateWebhookSecret", { id: routineId })
        setSecret(rotated.secret)
        refresh()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  return (
    <Field>
      <FieldLabel htmlFor={id}>{m.routines_webhook_url_label()}</FieldLabel>
      {AsyncResult.builder(result)
        .onInitial(() => <SkeletonList label={m.routines_loading()} rowClassName="h-8" />)
        .onSuccess(({ url, hasSecret, listenError }) => (
          <>
            <CopyField id={id} value={url} copyLabel={m.routines_copy_url()} />
            {listenError && <FieldError>{m.routines_listen_failed({ message: listenError })}</FieldError>}
            <div className="flex items-start gap-1.5">
              <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-input bg-muted/40 px-2.5 py-2 font-mono text-xs">
                {curlExample(url)}
              </pre>
              <CopyButton value={curlExample(url)} label={m.routines_copy_curl()} />
            </div>
            <div className="flex items-center gap-2">
              {hasSecret ? (
                <RotateSecret machine={machine} pending={pending} onConfirm={rotate} />
              ) : (
                <Button variant="outline" size="sm" disabled={pending} onClick={rotate}>
                  {m.routines_secret_create()}
                </Button>
              )}
            </div>
          </>
        ))
        .onError((cause) => <FieldError>{errorMessage(cause)}</FieldError>)
        .orElse(() => null)}
      {error && <FieldError>{error}</FieldError>}
      {secret !== null && <SecretDialog secret={secret} onClose={() => startTransition(() => setSecret(null))} />}
    </Field>
  )
}

interface RotateSecretProps {
  readonly machine: string
  readonly pending: boolean
  readonly onConfirm: () => void
}

function RotateSecret({ machine, pending, onConfirm }: RotateSecretProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>
        {m.routines_secret_rotate()}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.routines_secret_rotate_title()}</AlertDialogTitle>
          <AlertDialogDescription>{m.routines_secret_rotate_description({ machine })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{m.routines_secret_rotate()}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function SecretDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
  const id = useId()
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{m.routines_secret_title()}</DialogTitle>
          <DialogDescription>{m.routines_secret_description()}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={id}>{m.routines_secret_label()}</FieldLabel>
            <CopyField id={id} value={secret} copyLabel={m.routines_copy_secret()} />
          </Field>
          <div className="flex flex-col gap-2 text-sm">
            <p>{m.routines_secret_auth()}</p>
            <code className="rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs break-all">
              Authorization: Bearer &lt;secret&gt;
            </code>
            <code className="rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs break-all">
              X-Hub-Signature-256: sha256=&lt;HMAC-SHA256(secret, body)&gt;
            </code>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{m.routines_secret_done()}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const RUN_PAGE = 20

function RunList({ runs }: { runs: ReadonlyArray<RoutineRun> }) {
  const [shown, setShown] = useState(RUN_PAGE)
  const [, startShowing] = useTransition()
  return (
    <>
      <ul className="flex flex-col divide-y divide-foreground/8">
        {runs.slice(0, shown).map((run) => (
          <RunRow key={run.id} run={run} />
        ))}
      </ul>
      {runs.length > shown && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => startShowing(() => setShown(shown + RUN_PAGE))}
        >
          {m.routines_runs_more({ count: Math.min(RUN_PAGE, runs.length - shown) })}
        </Button>
      )}
    </>
  )
}

function RecentRuns({ routineId }: { routineId: string }) {
  const runs = useAtomValue(routineRunsAtom(routineId))
  const refresh = useAtomRefresh(routineRunsAtom(routineId))

  return (
    <section aria-label={m.routines_runs_title()} className="flex flex-col gap-2">
      <h4 className="text-sm font-medium">{m.routines_runs_title()}</h4>
      {AsyncResult.builder(runs)
        .onInitial(() => <SkeletonList label={m.routines_loading()} rowClassName="h-8" />)
        .onSuccess((list) =>
          list.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.routines_never_run()}</p>
          ) : (
            <RunList runs={list} />
          ),
        )
        .onError((cause) => (
          <div className="flex items-center gap-2">
            <p className="text-sm text-destructive">{errorMessage(cause)}</p>
            <Button variant="ghost" size="sm" onClick={refresh}>
              {m.common_retry()}
            </Button>
          </div>
        ))
        .orElse(() => null)}
    </section>
  )
}

function RunRow({ run }: { run: RoutineRun }) {
  return (
    <li className="flex flex-col gap-1 py-2 text-sm">
      <div className="flex items-center gap-2">
        <RunStatusBadge status={run.status} />
        <span className="text-muted-foreground">{runSourceLabel[run.source]()}</span>
        <time dateTime={run.createdAt} className="text-muted-foreground tabular-nums">
          {formatTime(run.createdAt)}
        </time>
        {run.threadId !== null && (
          <Link
            to="/thread/$threadId"
            params={{ threadId: run.threadId }}
            className="ms-auto underline underline-offset-4"
          >
            {m.routines_open_thread()}
          </Link>
        )}
      </div>
      {run.error !== null && (
        <p
          className={cn(
            "wrap-break-word whitespace-pre-wrap",
            run.status === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {run.error}
        </p>
      )}
    </li>
  )
}
