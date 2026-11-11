import { useAtomMount, useAtomSubscribe, useAtomValue } from "@effect/atom-react"
import type { OpenPullRequest, Thread } from "@shared/domain.ts"
import { Effect, Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useState } from "react"
import { Pressable, StyleSheet, Text, TextInput } from "react-native"
import { Icon } from "@/components/icon"
import { OptionRow, Section, Sheet } from "@/components/sheet"
import { HIT, mono, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { request, type RpcError } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { familyOf, beforeFirstHandshake, reportFailure, rpcFamily } from "@/lib/remote"
import { refIcon } from "@/lib/workspace-ref"
import { useDrafts, type Workspace } from "@/stores/drafts"

const CHIP_HEIGHT = 32
const SUGGESTIONS_PER_GROUP = 20

const currentBranchAtom = rpcFamily("projects.currentBranch")

function useCurrentBranch(projectId: string) {
  const result = useAtomValue(currentBranchAtom({ id: projectId }))
  return Option.getOrElse(AsyncResult.value(result), () => "")
}

interface Refs {
  readonly branches: readonly string[]
  readonly pullRequests: readonly OpenPullRequest[]
  readonly defaultBranch: string | null
}

const noRefs: Refs = { branches: [], pullRequests: [], defaultBranch: null }

const branchesAtom = familyOf((projectId: string) =>
  Atom.make((get) => {
    if (beforeFirstHandshake(get)) return Effect.never
    return Effect.all({
      branches: request("projects.branches", { id: projectId }),
      defaultBranch: request("projects.defaultBranch", { id: projectId }),
    }, { concurrency: "unbounded" })
  }),
)

const fetchOriginAtom = familyOf((projectId: string) =>
  Atom.make((get) =>
    request("projects.fetch", { id: projectId }).pipe(
      Effect.tap(() => Effect.sync(() => get.refresh(branchesAtom(projectId)))),
    ),
  ),
)

const pullRequestsAtom = rpcFamily("projects.pullRequests")

type Listed<A> = Atom.Atom<AsyncResult.AsyncResult<A, RpcError>>

const closedBranchesAtom: Listed<{ readonly branches: readonly string[]; readonly defaultBranch: string }> = Atom.make(
  AsyncResult.initial(),
)
const closedPullRequestsAtom: Listed<readonly OpenPullRequest[]> = Atom.make(AsyncResult.initial())
const closedFetchAtom: Listed<unknown> = Atom.make(AsyncResult.initial())

function useRefs(projectId: string, open: boolean, onError: (message: string) => void): Refs {
  const branchesSource = open ? branchesAtom(projectId) : closedBranchesAtom
  const listed = AsyncResult.value(useAtomValue(branchesSource))
  const pullRequests = AsyncResult.value(useAtomValue(open ? pullRequestsAtom({ id: projectId }) : closedPullRequestsAtom))
  useAtomMount<AsyncResult.AsyncResult<unknown, RpcError>>(open ? fetchOriginAtom(projectId) : closedFetchAtom)
  useAtomSubscribe(branchesSource, reportFailure(onError))
  const { branches, defaultBranch } = Option.getOrElse(listed, () => noRefs)
  return { branches, defaultBranch, pullRequests: Option.getOrElse(pullRequests, () => noRefs.pullRequests) }
}

function filterRefs({ branches, pullRequests }: Refs, query: string) {
  const trimmed = query.trim()
  const needle = trimmed.toLowerCase()
  const showAll = branches.includes(trimmed) || pullRequests.some((pullRequest) => `#${pullRequest.number}` === trimmed)
  const matching = <T,>(items: readonly T[], text: (item: T) => string) =>
    (showAll ? items : items.filter((item) => text(item).toLowerCase().includes(needle))).slice(
      0,
      SUGGESTIONS_PER_GROUP,
    )
  return {
    pullRequests: matching(
      pullRequests,
      (pullRequest) => `#${pullRequest.number} ${pullRequest.title} ${pullRequest.headRefName}`,
    ),
    branches: matching(branches, (branch) => branch),
  }
}

export function useWorkspace(thread: Thread) {
  const workspace = useDrafts((state) => state.workspaces[thread.id])
  const currentBranch = useCurrentBranch(thread.projectId)
  const mode = workspace?.mode ?? "local"
  const ref = workspace?.ref ?? currentBranch
  return { mode, ref, label: ref === "" ? copy("mobile_workspace_project_root") : ref }
}

export function WorkspaceChip({ thread, onError }: { thread: Thread; onError: (message: string) => void }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const { mode, ref, label } = useWorkspace(thread)

  return (
    <>
      <Pressable
        testID="composer-workspace"
        accessibilityRole="button"
        accessibilityLabel={copy("mobile_workspace_title")}
        accessibilityValue={{ text: mode === "worktree" ? copy("mobile_workspace_new_worktree_from", { ref: label }) : label }}
        onPress={() => setOpen(true)}
        hitSlop={{ top: (HIT - CHIP_HEIGHT) / 2, bottom: (HIT - CHIP_HEIGHT) / 2 }}
        style={({ pressed }) => [styles.chip, pressed && { backgroundColor: theme.surfaceStrong }]}
      >
        <Icon name={refIcon(ref)} size={14} color={theme.textMuted} />
        <Text numberOfLines={1} style={[styles.chipLabel, ref !== "" && styles.mono, { color: theme.text }]}>
          {label}
        </Text>
        {mode === "worktree" && <Text style={[styles.chipMode, { color: theme.textMuted }]}>{copy("mobile_workspace_worktree")}</Text>}
      </Pressable>
      <WorkspaceSheet
        thread={thread}
        workspace={{ mode, ref }}
        open={open}
        onClose={() => setOpen(false)}
        onError={onError}
      />
    </>
  )
}

export function WorkspaceSheet({
  thread,
  workspace,
  open,
  onClose,
  onError,
}: {
  thread: Thread
  workspace: Workspace
  open: boolean
  onClose: () => void
  onError: (message: string) => void
}) {
  const theme = useTheme()
  const refs = useRefs(thread.projectId, open, onError)
  const { pullRequests, branches } = filterRefs(refs, workspace.ref)
  const setWorkspace = (next: Workspace | null) => useDrafts.getState().setWorkspace(thread.id, next)
  const pick = (ref: string) => setWorkspace({ mode: workspace.mode, ref })

  return (
    <Sheet
      title={copy("mobile_workspace_title")}
      open={open}
      onClose={onClose}
      header={
        <TextInput
          testID="workspace-ref"
          accessibilityLabel={copy("mobile_workspace_ref_label")}
          value={workspace.ref}
          onChangeText={pick}
          placeholder={copy("mobile_workspace_ref_placeholder")}
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          clearButtonMode="while-editing"
          style={[styles.refInput, { color: theme.text, backgroundColor: theme.card, borderColor: theme.border }]}
        />
      }
    >
      <Section title={copy("mobile_workspace_run_in")}>
        <OptionRow
          label={copy("mobile_workspace_project_root")}
          icon="Folder"
          hint={copy("mobile_workspace_project_root_hint")}
          selected={workspace.mode === "local"}
          onPress={() => workspace.mode !== "local" && setWorkspace(null)}
        />
        <OptionRow
          label={copy("mobile_workspace_new_worktree")}
          icon="Branch"
          hint={copy("mobile_workspace_new_worktree_hint")}
          selected={workspace.mode === "worktree"}
          onPress={() =>
            workspace.mode !== "worktree" &&
            setWorkspace({ mode: "worktree", ref: refs.defaultBranch ?? workspace.ref })
          }
        />
      </Section>
      {pullRequests.length > 0 && (
        <Section title={copy("mobile_workspace_pull_requests")}>
          {pullRequests.map((pullRequest) => {
            const ref = `#${pullRequest.number}`
            return (
              <OptionRow
                key={pullRequest.number}
                label={`${ref} ${pullRequest.title}`}
                hint={pullRequest.isDraft ? copy("mobile_workspace_draft", { branch: pullRequest.headRefName }) : pullRequest.headRefName}
                icon="RiGitPullRequestLine"
                selected={workspace.ref.trim() === ref}
                onPress={() => pick(ref)}
              />
            )
          })}
        </Section>
      )}
      {branches.length > 0 && (
        <Section title={copy("mobile_workspace_branches")}>
          {branches.map((branch) => (
            <OptionRow
              key={branch}
              label={branch}
              icon="Branch"
              monospace
              selected={workspace.ref.trim() === branch}
              onPress={() => pick(branch)}
            />
          ))}
        </Section>
      )}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  chip: {
    height: CHIP_HEIGHT,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    borderRadius: radius.full,
  },
  chipLabel: { flexShrink: 1, fontSize: 12 },
  mono: { fontFamily: mono },
  chipMode: { fontSize: 12, fontWeight: "500" },
  refInput: {
    minHeight: HIT + 4,
    paddingHorizontal: 16,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    fontFamily: mono,
    fontSize: 14,
  },
})
