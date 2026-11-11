import { parsePullRequestSelector } from "@shared/github.ts"
import type { IconName } from "@/components/icon"

export const refIcon = (ref: string): IconName =>
  ref === "" ? "Folder" : parsePullRequestSelector(ref) ? "RiGitPullRequestLine" : "Branch"
