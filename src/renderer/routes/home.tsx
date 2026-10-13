import { useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { RiAddLine, RiFolderAddLine } from "react-icons/ri"
import { ChordKeys } from "../components/ChordKeys.tsx"
import { Button } from "../components/ui/button.tsx"
import { commands } from "../keybindings/commands.ts"
import { useKeymap } from "../keybindings/useKeybindings.ts"
import { projectsAtom } from "../lib/rpc.ts"
import { startThread } from "../lib/startThread.ts"
import { windowProjectId } from "../lib/windowProject.ts"
import { m } from "../paraglide/messages.js"
import { useUi } from "../stores/ui.ts"

const commandTitle = (id: "thread.new" | "project.add") => commands.find((command) => command.id === id)?.title() ?? ""

export function HomeRoute() {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const keymap = useKeymap()
  const firstProject = projects.find((project) => project.id === windowProjectId) ?? projects[0]
  const navigate = useNavigate()

  const addProject = (
    <Button
      size="lg"
      variant={firstProject ? "outline" : "default"}
      onClick={() => useUi.getState().setAddProjectOpen(true)}
    >
      <RiFolderAddLine aria-hidden />
      {commandTitle("project.add")}
      {keymap["project.add"] && <ChordKeys chord={keymap["project.add"]} />}
    </Button>
  )

  return (
    <div className="m-auto flex max-w-lg flex-col items-center gap-6 px-6 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-semibold">{m.app_name()}</h1>
        <p className="text-sm text-balance text-muted-foreground">{m.home_description()}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {firstProject && (
          <Button size="lg" onClick={() => void startThread(firstProject.id, navigate)}>
            <RiAddLine aria-hidden />
            {commandTitle("thread.new")}
            {keymap["thread.new"] && <ChordKeys chord={keymap["thread.new"]} />}
          </Button>
        )}
        {addProject}
      </div>
      {firstProject && windowProjectId === null && (
        <p className="text-xs text-balance text-muted-foreground">
          {m.home_hint_ready({ project: firstProject.name })}
        </p>
      )}
    </div>
  )
}
