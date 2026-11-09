import type { IconName } from "@/components/icon"
import { copy } from "@/lib/copy"

export type ThreadTab = "chat" | "files" | "prs" | "artifacts" | "terminal"

export const threadTabs: readonly { value: ThreadTab; label: string; icon: IconName }[] = [
  { value: "chat", label: copy("mobile_thread_tab_chat"), icon: "Chat" },
  { value: "files", label: copy("mobile_thread_tab_files"), icon: "Folder" },
  { value: "prs", label: copy("mobile_thread_tab_prs"), icon: "RiGitPullRequestLine" },
  { value: "artifacts", label: copy("mobile_thread_tab_artifacts"), icon: "Layout" },
  { value: "terminal", label: copy("mobile_thread_tab_terminal"), icon: "Terminal" },
]

/** The views the bar at the foot of a thread offers. The terminal opens from the thread's actions menu instead. */
export const barTabs = threadTabs.filter((item) => item.value !== "terminal")
