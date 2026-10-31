import { useAtomValue } from "@effect/atom-react"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useEffect } from "react"
import { isThreadBusy, type Thread } from "../../../shared/domain.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { repositoryAtom, callPromise } from "../../lib/rpc.ts"
import { sidechatAtom } from "../../lib/sidechat.ts"
import { ThreadRepository } from "../../lib/threadRepository.ts"
import { ThreadFolder, useThreadRoot } from "../../lib/threadRoot.ts"
import { m } from "../../paraglide/messages.js"
import { useMessages } from "../../stores/messages.ts"
import { useThreads } from "../../stores/threads.ts"
import { Composer } from "../Composer.tsx"
import { MessageList } from "../MessageList.tsx"
import { SubagentLinks } from "../MessagePart.tsx"
import { providerLabel } from "../ProviderIcon.tsx"
import { PendingRequests } from "../ThreadView.tsx"
import { Button } from "../ui/button.tsx"
import { ChatNewIcon } from "../icons/ChatNewIcon.tsx"

export function SidechatView({ thread }: { thread: Thread }) {
  const sidechat = useThreads((state) => state.sidechats[thread.id])
  return sidechat ? <SidechatTranscript key={sidechat.id} sidechat={sidechat} /> : <OpenSidechat threadId={thread.id} />
}

function OpenSidechat({ threadId }: { threadId: string }) {
  const opened = useAtomValue(sidechatAtom(threadId))
  if (!AsyncResult.isFailure(opened)) return null
  return (
    <p role="alert" className="m-auto px-4 text-center text-sm text-destructive">
      {m.sidechat_open_failed({ message: errorMessage(Cause.squash(opened.cause)) })}
    </p>
  )
}

function SidechatTranscript({ sidechat }: { sidechat: Thread }) {
  const history = useMessages((state) => state.byThread[sidechat.id])
  const load = useMessages((state) => state.load)
  const unload = useMessages((state) => state.unload)
  const repository = AsyncResult.getOrElse(useAtomValue(repositoryAtom(sidechat.projectId)), () => null)
  const folder = useThreadRoot(sidechat)?.path ?? null

  useEffect(() => {
    void load(sidechat.id)
    return () => unload(sidechat.id)
  }, [load, unload, sidechat.id])

  return (
    <div className="flex min-h-0 flex-1 flex-col [container-type:size]">
      <ThreadRepository value={repository}>
        <ThreadFolder value={folder}>
          {history?.status === "ready" && history.messages.length > 0 ? (
            <SubagentLinks value={false}>
              <MessageList messages={history.messages} providerLabel={providerLabel[sidechat.provider]()} />
            </SubagentLinks>
          ) : (
            <div className="flex-1" />
          )}
        </ThreadFolder>
      </ThreadRepository>
      <Composer thread={sidechat}>
        <PendingRequests thread={sidechat} />
      </Composer>
    </div>
  )
}

export function SidechatHeader({ thread }: { thread: Thread }) {
  const sidechat = useThreads((state) => state.sidechats[thread.id])
  const started = useMessages((state) => {
    const history = sidechat && state.byThread[sidechat.id]
    return history?.status === "ready" && history.messages.length > 0
  })
  const discard = async () => {
    if (sidechat) await callPromise("threads.delete", { id: sidechat.id })
  }
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 pl-2">
      <h2 className="truncate text-sm font-medium">{m.panel_tab_sidechat()}</h2>
      {started && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m.sidechat_new()}
          title={m.sidechat_new()}
          disabled={sidechat === undefined || isThreadBusy(sidechat.status)}
          action={discard}
          className="ms-auto"
        >
          <ChatNewIcon aria-hidden />
        </Button>
      )}
    </div>
  )
}
