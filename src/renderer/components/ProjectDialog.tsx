import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, startTransition, useActionState, useState } from "react"
import { RiFolderOpenLine, RiGithubFill } from "react-icons/ri"
import type { Project } from "../../shared/domain.ts"
import { type GitHubRepository, parseGitHubRepository } from "../../shared/github.ts"
import {
  callPromise,
  cloneProjectAtom,
  createProjectAtom,
  type EnvironmentId,
  projectsAtom,
  updateProjectAtom,
} from "../lib/rpc.ts"
import { environmentName, environmentOf, useClouds } from "../lib/environments.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "./ui/field.tsx"
import { Input } from "./ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx"
import { Switch } from "./ui/switch.tsx"
import { Textarea } from "./ui/textarea.tsx"
import { errorMessage } from "../lib/errorMessage.ts"
import { suggestProjectName } from "../lib/projectName.ts"

interface ProjectDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** The project to edit. Without one the dialog adds a new project. */
  readonly project?: Project
  /** Where a new project starts out. */
  readonly environment?: EnvironmentId
}

export function ProjectDialog({ open, onOpenChange, project, environment = null }: ProjectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{project ? m.project_edit_title() : m.project_dialog_title()}</DialogTitle>
          <DialogDescription>
            {project ? m.project_edit_description({ project: project.name }) : m.project_dialog_description()}
          </DialogDescription>
        </DialogHeader>
        {/* Inside the popup so the form state resets every time the dialog opens. */}
        <ProjectForm project={project} initialEnvironment={environment} onSaved={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

const parentOf = (path: string) => path.replace(/[\\/][^\\/]*[\\/]?$/, "")

/**
 * Where a clone lands unless the user picks another folder: next to the newest project in the same environment,
 * else `~/code`.
 */
function useDefaultCloneParent(environment: EnvironmentId) {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), (): ReadonlyArray<Project> => []).filter(
    (candidate) => environmentOf(candidate) === environment,
  )
  const newest = projects.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).at(0)
  return newest ? parentOf(newest.rootPath) : "~/code"
}

interface ProjectFormProps {
  readonly project: Project | undefined
  readonly initialEnvironment: EnvironmentId
  readonly onSaved: () => void
}

function ProjectForm({ project, initialEnvironment, onSaved }: ProjectFormProps) {
  const createProject = useAtomSet(createProjectAtom, { mode: "promise" })
  const cloneProject = useAtomSet(cloneProjectAtom, { mode: "promise" })
  const updateProject = useAtomSet(updateProjectAtom, { mode: "promise" })
  const [rootPath, setRootPath] = useState(project?.rootPath ?? "")
  // Null until the user types a name, so the name follows the folder or repository typed above it.
  const [typedName, setTypedName] = useState<string | null>(project?.name ?? null)
  const name = typedName ?? suggestProjectName(rootPath)
  const [linearReview, setLinearReview] = useState(project?.linearReview ?? false)
  // An existing project's folder is always local; a new one may be typed as a GitHub repository.
  const repository = project ? null : parseGitHubRepository(rootPath)
  const [cloneTo, setCloneTo] = useState<string | null>(null)
  const [environment, setEnvironment] = useState<EnvironmentId>(() =>
    project ? environmentOf(project) : initialEnvironment,
  )
  const defaultCloneTo = `${useDefaultCloneParent(environment)}/${repository?.name ?? ""}`
  const canBrowse = environment === null

  const [error, submit, isPending] = useActionState(async (_: string | null, form: FormData) => {
    const setupScript = String(form.get("setupScript") ?? "").trim() || null
    try {
      if (project)
        await updateProject({ id: project.id, name: name.trim(), rootPath: rootPath.trim(), setupScript, linearReview })
      else if (repository)
        await cloneProject({
          environment,
          repository,
          rootPath: (cloneTo ?? defaultCloneTo).trim(),
          name: name.trim() || repository.name,
          setupScript,
        })
      else await createProject({ environment, name: name.trim(), rootPath: rootPath.trim(), setupScript })
    } catch (cause) {
      return errorMessage(cause)
    }
    onSaved()
    return null
  }, null)

  const browse = async () => {
    const picked = await callPromise("dialog.pickFolder", undefined)
    if (!picked) return
    setRootPath(picked)
    if (!typedName?.trim()) setTypedName(null)
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    startTransition(() => submit(form))
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <FieldGroup>
        <WhereField editable={!project} value={environment} onChange={setEnvironment} />
        <Field>
          <FieldLabel htmlFor="project-root">{project ? m.project_root_label() : m.project_source_label()}</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="project-root"
              required
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder={m.project_root_placeholder()}
              spellCheck={false}
            />
            {canBrowse && (
              <Button type="button" variant="outline" onClick={browse}>
                <RiFolderOpenLine aria-hidden />
                {m.project_root_browse()}
              </Button>
            )}
          </div>
          {repository && <RepositoryNotice repository={repository} />}
        </Field>
        {repository && (
          <CloneTarget
            repository={repository}
            value={cloneTo ?? defaultCloneTo}
            canBrowse={canBrowse}
            onChange={setCloneTo}
          />
        )}
        <Field>
          <FieldLabel htmlFor="project-name">{m.project_name_label()}</FieldLabel>
          <Input
            id="project-name"
            required={!repository}
            value={name}
            onChange={(event) => setTypedName(event.target.value)}
            placeholder={repository?.name ?? m.project_name_placeholder()}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="project-setup">
            {m.project_setup_label()}
            <span className="font-normal text-muted-foreground">{m.project_setup_optional()}</span>
          </FieldLabel>
          <Textarea
            id="project-setup"
            name="setupScript"
            rows={4}
            defaultValue={project?.setupScript ?? ""}
            className="font-mono text-xs"
            placeholder={m.project_setup_placeholder()}
            spellCheck={false}
          />
          <FieldDescription>
            {m.project_setup_hint()}
            <span className="mt-1 flex flex-col gap-0.5">
              <span>
                <code className="font-mono text-foreground">$HINACODE_ROOT_PATH</code> {m.project_setup_root_var()}
              </span>
              <span>
                <code className="font-mono text-foreground">$HINACODE_WORKTREE_PATH</code>{" "}
                {m.project_setup_worktree_var()}
              </span>
            </span>
          </FieldDescription>
        </Field>
        {project && (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="project-linear-review">{m.project_linear_review()}</FieldLabel>
              <FieldDescription>{m.project_linear_review_hint()}</FieldDescription>
            </FieldContent>
            <Switch id="project-linear-review" checked={linearReview} onCheckedChange={setLinearReview} />
          </Field>
        )}
      </FieldGroup>
      {error && <FieldError>{error}</FieldError>}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>{m.common_cancel()}</DialogClose>
        <Button type="submit" disabled={isPending}>
          {project
            ? m.project_save()
            : !repository
              ? m.project_submit()
              : isPending
                ? m.project_cloning()
                : m.project_clone_submit()}
        </Button>
      </DialogFooter>
    </form>
  )
}

function RepositoryNotice({ repository }: { repository: GitHubRepository }) {
  return (
    <FieldDescription className="flex items-center gap-1.5">
      <RiGithubFill aria-hidden className="size-3.5 shrink-0" />
      {m.project_github_repository({ repository: `${repository.owner}/${repository.name}` })}
    </FieldDescription>
  )
}

interface CloneTargetProps {
  readonly repository: GitHubRepository
  readonly value: string
  readonly canBrowse: boolean
  readonly onChange: (path: string) => void
}

/** The folder the repository is cloned into. Browse picks its parent, since the clone creates the folder. */
function CloneTarget({ repository, value, canBrowse, onChange }: CloneTargetProps) {
  const browse = async () => {
    const parent = await callPromise("dialog.pickFolder", undefined)
    if (parent) onChange(`${parent}/${repository.name}`)
  }

  return (
    <Field>
      <FieldLabel htmlFor="project-clone-to">{m.project_clone_to_label()}</FieldLabel>
      <div className="flex gap-2">
        <Input
          id="project-clone-to"
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          className="font-mono"
        />
        {canBrowse && (
          <Button type="button" variant="outline" onClick={browse}>
            <RiFolderOpenLine aria-hidden />
            {m.project_root_browse()}
          </Button>
        )}
      </div>
    </Field>
  )
}

const THIS_MACHINE = ""

interface WhereFieldProps {
  /** A project stays where it was added, so editing one only shows where it lives. */
  readonly editable: boolean
  readonly value: EnvironmentId
  readonly onChange: (environment: EnvironmentId) => void
}

function WhereField({ editable, value, onChange }: WhereFieldProps) {
  const clouds = useClouds()
  if (clouds.length === 0 && value === null) return null
  if (!editable)
    return (
      <Field>
        <FieldLabel htmlFor="project-where">{m.project_where_label()}</FieldLabel>
        <Input id="project-where" readOnly value={environmentName(value, clouds)} />
      </Field>
    )
  const items = [
    { value: THIS_MACHINE, label: m.environment_this_machine() },
    ...clouds.map((cloud) => ({ value: cloud.id, label: cloud.name })),
  ]
  return (
    <Field>
      <FieldLabel htmlFor="project-where">{m.project_where_label()}</FieldLabel>
      <div>
        <Select
          items={items}
          value={value ?? THIS_MACHINE}
          onValueChange={(next) => typeof next === "string" && onChange(next === THIS_MACHINE ? null : next)}
        >
          <SelectTrigger id="project-where" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {value !== null && <FieldDescription>{m.project_where_cloud_hint()}</FieldDescription>}
    </Field>
  )
}
