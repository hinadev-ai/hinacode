import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { IconType } from "react-icons"
import { RiAddLine, RiFolderAddLine } from "react-icons/ri"
import { AppMark } from "../components/AppMark.tsx"
import { ChordKeys } from "../components/ChordKeys.tsx"
import { useKeymap } from "../keybindings/useKeybindings.ts"
import { projectsAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useUi } from "../stores/ui.ts"

export function HomeRoute() {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const keymap = useKeymap()
  const firstProject = projects[0]

  return (
    <div className="m-auto flex w-full max-w-sm flex-col gap-8 px-6">
      <div className="flex flex-col gap-3">
        <AppMark className="size-9 rounded-[9px] text-lg" />
        <h1 className="text-xl font-semibold tracking-tight">{m.app_name()}</h1>
        <p className="text-sm text-pretty text-muted-foreground">{m.home_description()}</p>
      </div>
      <ul className="flex flex-col gap-px">
        {firstProject && (
          <li>
            <StartAction
              icon={RiAddLine}
              label={m.sidebar_new_thread_in({ project: firstProject.name })}
              chord={keymap["thread.new"]}
              onClick={() => useUi.getState().setNewThreadProjectId(firstProject.id)}
            />
          </li>
        )}
        <li>
          <StartAction
            icon={RiFolderAddLine}
            label={m.sidebar_add_project()}
            chord={keymap["project.add"]}
            onClick={() => useUi.getState().setAddProjectOpen(true)}
          />
        </li>
      </ul>
    </div>
  )
}

interface StartActionProps {
  readonly icon: IconType
  readonly label: string
  readonly chord: string | undefined
  readonly onClick: () => void
}

function StartAction({ icon: Icon, label, chord, onClick }: StartActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-3 flex h-10 w-[calc(100%+1.5rem)] items-center gap-3 rounded-lg px-3 text-left text-sm outline-none transition-colors duration-100 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {chord && <ChordKeys chord={chord} />}
    </button>
  )
}
