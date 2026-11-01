import type { OpenPullRequest, Thread } from "@shared/domain.ts"
import { parsePullRequestSelector } from "@shared/github.ts"
import { useEffect, useState } from "react"
import { Pressable, StyleSheet, Text, TextInput } from "react-native"
import { Icon } from "@/components/icon"
import { OptionRow, Section, Sheet } from "@/components/sheet"
import { HIT, mono, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { useDrafts, type Workspace } from "@/stores/drafts"

const CHIP_HEIGHT = 32
const SUGGESTIONS_PER_GROUP = 20

/** The branch checked out in the project root, which a thread without a picked workspace runs on. */
function useCurrentBranch(projectId: string) {
  const connected = useConnection((state) => state.status === "connected")
  const [branch, setBranch] = useState("")
  useEffect(() => {
    if (!connected) return
    let current = true
    call("projects.currentBranch", { id: projectId }).then(
      (next) => current && setBranch(next),
      () => {},
    )
    return () => {
      current = false
    }
  }, [connected, projectId])
  return branch
}

interface Refs {
  readonly branches: readonly string[]
  readonly pullRequests: readonly OpenPullRequest[]
  readonly defaultBranch: string | null
}

const noRefs: Refs = { branches: [], pullRequests: [], defaultBranch: null }

/** Branches and open pull requests while the sheet is open, listed again once a fetch of `origin` settles. */
function useRefs(projectId: string, open: boolean, onError: (message: string) => void) {
  const [refs, setRefs] = useState(noRefs)
  useEffect(() => {
    if (!open) return
    let current = true
    const update = (patch: Partial<Refs>) => current && setRefs((previous) => ({ ...previous, ...patch }))
    const fail = (cause: unknown) => current && onError(errorText(cause))
    const listBranches = () =>
      Promise.all([call("projects.branches", { id: projectId }), call("projects.defaultBranch", { id: projectId })]).then(
        ([branches, defaultBranch]) => update({ branches, defaultBranch }),
      )
    listBranches().catch(fail)
    // A repository without a GitHub remote has no pull requests to offer, which is not worth an error.
    call("projects.pullRequests", { id: projectId }).then(
      (pullRequests) => update({ pullRequests }),
      () => {},
    )
    // Offline the fetch fails, and the branches already listed are still worth offering.
    call("projects.fetch", { id: projectId })
      .then(listBranches)
      .catch(() => {})
    return () => {
      current = false
    }
  }, [open, projectId, onError])
  return refs
}

/** Pull requests, then branches, containing the query. A query that is exactly one of them shows them all. */
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

/**
 * Where the first turn runs: the project root, switched to a branch or pull request on send, or a new
 * worktree forked from a branch or checked out from a pull request. Shown until the first message.
 */
export function WorkspaceChip({ thread, onError }: { thread: Thread; onError: (message: string) => void }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const workspace = useDrafts((state) => state.workspaces[thread.id])
  const currentBranch = useCurrentBranch(thread.projectId)
  const mode = workspace?.mode ?? "local"
  const ref = workspace?.ref ?? currentBranch
  const label = ref === "" ? copy("mobile_workspace_project_root") : ref

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
        <Icon
          name={parsePullRequestSelector(ref) ? "RiGitPullRequestLine" : "RiGitBranchLine"}
          size={14}
          color={theme.textMuted}
        />
        <Text numberOfLines={1} style={[styles.chipLabel, { color: theme.text }]}>
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

function WorkspaceSheet({
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
          style={[styles.refInput, { color: theme.text, backgroundColor: theme.sheetRaised, borderColor: theme.border }]}
        />
      }
    >
      <Section title={copy("mobile_workspace_run_in")}>
        <OptionRow
          label={copy("mobile_workspace_project_root")}
          icon="RiFolderLine"
          hint={copy("mobile_workspace_project_root_hint")}
          selected={workspace.mode === "local"}
          onPress={() => workspace.mode !== "local" && setWorkspace(null)}
        />
        <OptionRow
          label={copy("mobile_workspace_new_worktree")}
          icon="RiGitBranchLine"
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
              icon="RiGitBranchLine"
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
  chipLabel: { flexShrink: 1, fontFamily: mono, fontSize: 12 },
  chipMode: { fontSize: 12, fontWeight: "500" },
  refInput: {
    minHeight: HIT,
    marginHorizontal: 4,
    marginBottom: 8,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontFamily: mono,
    fontSize: 14,
  },
})
