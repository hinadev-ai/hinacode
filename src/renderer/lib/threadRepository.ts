import { createContext, useContext } from "react"
import type { GitHubRepository } from "../../shared/github.ts"

/** The GitHub repository of the thread on screen, which `#n` links to. Null outside a thread or off GitHub. */
export const ThreadRepository = createContext<GitHubRepository | null>(null)

export const useThreadRepository = () => useContext(ThreadRepository)
