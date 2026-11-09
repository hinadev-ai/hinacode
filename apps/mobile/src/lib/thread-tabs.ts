import type { IconName } from "@/components/icon"
import { copy } from "@/lib/copy"

export type ThreadTab = "chat" | "files" | "prs" | "terminal"

export const threadTabs: readonly { value: ThreadTab; label: string; icon: IconName }[] = [
  { value: "chat", label: copy("mobile_thread_tab_chat"), icon: "Chat" },
  { value: "files", label: copy("mobile_thread_tab_files"), icon: "Folder" },
  { value: "prs", label: copy("mobile_thread_tab_prs"), icon: "RiGitPullRequestLine" },
  { value: "terminal", label: copy("mobile_thread_tab_terminal"), icon: "Terminal" },
]
