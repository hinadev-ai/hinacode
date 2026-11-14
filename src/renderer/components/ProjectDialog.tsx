import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import {
  type ComponentProps,
  type FormEvent,
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
} from "react"
import { RiGithubFill } from "react-icons/ri"
import { separatorOf } from "../../shared/directoryPath.ts"
import type { CloneProgress, Project } from "../../shared/domain.ts"
import { type GitHubRepository, parseGitHubRepository, type RepositoryVisibility } from "../../shared/github.ts"
import {
  callPromise,
  cloneProjectAtom,
  createProjectAtom,
  type EnvironmentId,
  onPushEvent,
  projectsAtom,
  updateProjectAtom,
} from "../lib/rpc.ts"
import { environmentName, environmentOf, useClouds } from "../lib/environments.ts"
import { m } from "../paraglide/messages.js"
import { inBrowser } from "../lib/runtime.ts"
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
import { errorMessage, toastError } from "../lib/errorMessage.ts"
import { suggestProjectName } from "../lib/projectName.ts"
import { startThread } from "../lib/startThread.ts"
import { FolderOpenIcon } from "@hinacode/icons"
import { PathInput } from "./PathInput.tsx"

interface ProjectDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly project?: Project
  readonly environment?: EnvironmentId
  readonly source?: { readonly rootPath: string; readonly name: string }
  readonly onCreated?: (project: Project) => void
  readonly finalFocus?: ComponentProps<typeof DialogContent>["finalFocus"]
}

export function ProjectDialog({
  open,
  onOpenChange,
  project,
  environment = null,
  source,
  onCreated,
  finalFocus,
}: ProjectDialogProps) {
  const navigate = useNavigate()
  const onSaved = (saved: Project) => {
    onOpenChange(false)
    if (project) return
    if (onCreated) onCreated(saved)
    else void startThread(saved, navigate)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>{project ? m.project_edit_title() : m.project_dialog_title()}</DialogTitle>
          <DialogDescription>
            {project ? m.project_edit_description({ project: project.name }) : m.project_dialog_description()}
          </DialogDescription>
        </DialogHeader>
        <ProjectForm project={project} initialEnvironment={environment} source={source} onSaved={onSaved} />
      </DialogContent>
    </Dialog>
  )
}

const parentOf = (path: string) => path.replace(/[\\/][^\\/]*[\\/]?$/, "")

function useDefaultCloneParent(environment: EnvironmentId) {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), (): ReadonlyArray<Project> => []).filter(
    (candidate) => candidate.kind === "folder" && environmentOf(candidate) === environment,
  )
  const newest = projects.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).at(0)
  return newest ? parentOf(newest.rootPath) : "~/code"
}

interface ProjectFormProps {
  readonly project: Project | undefined
  readonly initialEnvironment: EnvironmentId
  readonly source: ProjectDialogProps["source"]
  readonly onSaved: (project: Project) => void
}

function ProjectForm({ project, initialEnvironment, source: initial, onSaved }: ProjectFormProps) {
  const createProject = useAtomSet(createProjectAtom, { mode: "promise" })
  const cloneProject = useAtomSet(cloneProjectAtom, { mode: "promise" })
  const updateProject = useAtomSet(updateProjectAtom, { mode: "promise" })
  const [rootPath, setRootPath] = useState(project?.rootPath ?? initial?.rootPath ?? "")
  const [typedName, setTypedName] = useState<string | null>(project?.name ?? initial?.name ?? null)
  const name = typedName ?? suggestProjectName(rootPath)
  const [linearReview, setLinearReview] = useState(project?.linearReview ?? false)
  const repository = project ? null : parseGitHubRepository(rootPath)
  const [cloneTo, setCloneTo] = useState<string | null>(null)
  const [newRepository, setNewRepository] = useState<RepositoryVisibility | null>(null)
  const clouds = useClouds()
  const [environment, setEnvironment] = useState<EnvironmentId>(() =>
    project ? environmentOf(project) : (initialEnvironment ?? (inBrowser() ? (clouds[0]?.id ?? null) : null)),
  )
  const cloneParent = useDefaultCloneParent(environment)
  const defaultCloneTo = `${cloneParent}${separatorOf(cloneParent)}${repository?.name ?? ""}`
  const canBrowse = environment === null && !inBrowser()
  const runningClone = useRef<{ readonly cloneId: string; readonly environment: EnvironmentId } | null>(null)
  const [cloneProgress, setCloneProgress] = useState<CloneProgress | null>(null)

  useEffect(
    () =>
      onPushEvent((event) => {
        if (event.type === "project.cloneProgress" && event.cloneId === runningClone.current?.cloneId)
          setCloneProgress(event.progress)
      }),
    [],
  )

  useEffect(
    () => () => {
      const running = runningClone.current
      if (running)
        callPromise("projects.cancelClone", { cloneId: running.cloneId }, { environment: running.environment }).catch(
          toastError,
        )
    },
    [],
  )

  const clone = async (source: GitHubRepository, setupScript: string | null) => {
    const cloneId = crypto.randomUUID()
    runningClone.current = { cloneId, environment }
    setCloneProgress(null)
    try {
      return await cloneProject({
        environment,
        cloneId,
        repository: source,
        rootPath: (cloneTo ?? defaultCloneTo).trim(),
        name: name.trim() || source.name,
        setupScript,
      })
    } finally {
      runningClone.current = null
    }
  }

  const [error, submit, isPending] = useActionState(async (_: string | null, form: FormData) => {
    const setupScript = String(form.get("setupScript") ?? "").trim() || null
    const save = () => {
      if (project)
        return updateProject({
          id: project.id,
          name: name.trim(),
          rootPath: rootPath.trim(),
          setupScript,
          linearReview,
        })
      if (repository) return clone(repository, setupScript)
      return createProject({
        environment,
        name: name.trim(),
        rootPath: rootPath.trim(),
        setupScript,
        ...(newRepository ? { createRepository: newRepository } : {}),
      })
    }
    try {
      onSaved(await save())
    } catch (cause) {
      return errorMessage(cause)
    }
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
        <WhereField editable={!project} value={environment} canBrowse={canBrowse} onChange={setEnvironment} />
        <Field>
          <FieldLabel htmlFor="project-root">{project ? m.project_root_label() : m.project_source_label()}</FieldLabel>
          <div className="flex gap-2">
            <PathInput
              id="project-root"
              required
              value={rootPath}
              onChange={setRootPath}
              environment={environment}
              placeholder={m.project_root_placeholder()}
            />
            {canBrowse && (
              <Button type="button" variant="outline" action={() => browse().catch(toastError)}>
                <FolderOpenIcon aria-hidden />
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
            environment={environment}
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
        {!project && !repository && <NewRepositoryField value={newRepository} onChange={setNewRepository} />}
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
      {repository && isPending && <CloneProgressBar progress={cloneProgress} />}
      {error && <FieldError>{error}</FieldError>}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>{m.common_cancel()}</DialogClose>
        <Button type="submit" disabled={isPending}>
          {project
            ? m.project_save()
            : repository
              ? isPending
                ? m.project_cloning()
                : m.project_clone_submit()
              : isPending && newRepository
                ? m.project_creating_repository()
                : m.project_submit()}
        </Button>
      </DialogFooter>
    </form>
  )
}

function NewRepositoryField({
  value,
  onChange,
}: {
  value: RepositoryVisibility | null
  onChange: (visibility: RepositoryVisibility | null) => void
}) {
  const visibilities = [
    { value: "private", label: m.project_repository_private() },
    { value: "public", label: m.project_repository_public() },
  ] as const
  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor="project-create-repository" className="flex-1">
        <RiGithubFill aria-hidden className="size-4 shrink-0" />
        {m.project_create_repository()}
      </FieldLabel>
      {value !== null && (
        <Select
          items={visibilities}
          value={value}
          onValueChange={(next) => (next === "private" || next === "public") && onChange(next)}
        >
          <SelectTrigger size="sm" className="w-28" aria-label={m.project_create_repository()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {visibilities.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Switch
        id="project-create-repository"
        checked={value !== null}
        onCheckedChange={(checked) => onChange(checked ? "private" : null)}
      />
    </Field>
  )
}

function CloneProgressBar({ progress }: { progress: CloneProgress | null }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span className="truncate">{progress?.phase ?? m.project_clone_starting()}</span>
        {progress && <span>{progress.percent}%</span>}
      </div>
      <progress
        aria-label={m.project_clone_progress()}
        max={100}
        value={progress?.percent}
        className="h-1.5 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-200"
      />
    </div>
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
  readonly environment: EnvironmentId
  readonly onChange: (path: string) => void
}

function CloneTarget({ repository, value, canBrowse, environment, onChange }: CloneTargetProps) {
  const browse = async () => {
    const parent = await callPromise("dialog.pickFolder", undefined)
    if (parent) onChange(`${parent}${separatorOf(parent)}${repository.name}`)
  }

  return (
    <Field>
      <FieldLabel htmlFor="project-clone-to">{m.project_clone_to_label()}</FieldLabel>
      <div className="flex gap-2">
        <PathInput
          id="project-clone-to"
          required
          value={value}
          onChange={onChange}
          environment={environment}
          className="font-mono"
        />
        {canBrowse && (
          <Button type="button" variant="outline" action={() => browse().catch(toastError)}>
            <FolderOpenIcon aria-hidden />
            {m.project_root_browse()}
          </Button>
        )}
      </div>
    </Field>
  )
}

const THIS_MACHINE = ""

interface WhereFieldProps {
  readonly editable: boolean
  readonly value: EnvironmentId
  readonly canBrowse: boolean
  readonly onChange: (environment: EnvironmentId) => void
}

function WhereField({ editable, value, canBrowse, onChange }: WhereFieldProps) {
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
    ...(inBrowser() ? [] : [{ value: THIS_MACHINE, label: m.environment_this_machine() }]),
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
      {!canBrowse && <FieldDescription>{m.project_where_cloud_hint()}</FieldDescription>}
    </Field>
  )
}
