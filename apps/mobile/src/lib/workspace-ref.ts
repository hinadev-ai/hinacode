import { parsePullRequestSelector } from "@shared/github.ts"
import type { IconName } from "@/components/icon"

/** The icon for where a first turn runs: the project root, a branch, or a pull request. */
export const refIcon = (ref: string): IconName =>
  ref === "" ? "Folder" : parsePullRequestSelector(ref) ? "RiGitPullRequestLine" : "Branch"
