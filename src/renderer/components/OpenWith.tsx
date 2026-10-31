import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { toast } from "sonner"
import type { Opener, Thread } from "../../shared/domain.ts"
import { useThreadEnvironment } from "../lib/environments.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise, openersAtom, updateClientSettingsAtom } from "../lib/rpc.ts"
import { useClientSettings } from "../lib/settings.ts"
import { useThreadRoot } from "../lib/threadRoot.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx"
import { ChevronDownIcon } from "./icons/ChevronDownIcon.tsx"
import { ExternalIcon } from "./icons/ExternalIcon.tsx"
import { FolderOpenIcon } from "./icons/FolderOpenIcon.tsx"

type Target = "folder" | "file"

const useOpeners = (target: Target) => {
  const openers = AsyncResult.getOrElse(useAtomValue(openersAtom), (): ReadonlyArray<Opener> => [])
  return target === "file" ? openers.filter((opener) => opener.opensFiles) : openers
}

/** Opens `path` in the app, and remembers the app for the thread header's one-click button. */
const useOpenWith = () => {
  const save = useAtomSet(updateClientSettingsAtom, { mode: "promise" })
  return (path: string, opener: Opener) =>
    callPromise("shell.openWith", { path, opener: opener.id })
      .then(() => save({ openWith: opener.id }))
      .catch((cause: unknown) => toast.error(m.open_with_failed({ app: opener.name, message: errorMessage(cause) })))
}

function OpenerIcon({ opener }: { opener: Opener }) {
  return opener.icon ? (
    <img src={opener.icon} alt="" aria-hidden className="size-4 shrink-0" />
  ) : (
    <ExternalIcon aria-hidden />
  )
}

function OpenerItems({ path, target }: { path: string; target: Target }) {
  const openers = useOpeners(target)
  const open = useOpenWith()
  return (
    <>
      {openers.map((opener) => (
        <DropdownMenuItem key={opener.id} onClick={() => void open(path, opener)}>
          <OpenerIcon opener={opener} />
          {opener.name}
        </DropdownMenuItem>
      ))}
      {openers.length > 0 && <DropdownMenuSeparator />}
      <DropdownMenuItem onClick={() => void callPromise("shell.reveal", { path })}>
        <FolderOpenIcon aria-hidden />
        {m.panel_reveal()}
      </DropdownMenuItem>
    </>
  )
}

/** An "Open with" submenu for a menu that already lists other actions on `path`. */
export function OpenWithSubmenu({ path, target }: { path: string; target: Target }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <ExternalIcon aria-hidden />
        {m.open_with()}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <OpenerItems path={path} target={target} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** The thread header's "Open with" button. A cloud thread's folder is on that machine, so it has none. */
export function ThreadOpenWith({ thread }: { thread: Thread }) {
  const root = useThreadRoot(thread)
  const local = useThreadEnvironment(thread.id) === null
  if (!local || root === undefined) return null
  return <OpenWithButton path={root.path} />
}

/**
 * Opens the folder in the app used last with one click, and lists the other apps beside it. Before any app was
 * used, or once it is gone, the first app found stands in.
 */
function OpenWithButton({ path }: { path: string }) {
  const openers = useOpeners("folder")
  const { openWith } = useClientSettings()
  const open = useOpenWith()
  const preferred = openers.find((opener) => opener.id === openWith) ?? openers[0]

  return (
    <div className="flex shrink-0 items-center">
      {preferred && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m.open_in({ app: preferred.name })}
          title={m.open_in({ app: preferred.name })}
          onClick={() => void open(path, preferred)}
        >
          <OpenerIcon opener={preferred} />
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size={preferred ? "icon-xs" : "icon-sm"}
              aria-label={m.open_with()}
              title={m.open_with()}
            />
          }
        >
          {preferred ? <ChevronDownIcon aria-hidden /> : <ExternalIcon aria-hidden />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <OpenerItems path={path} target="folder" />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
