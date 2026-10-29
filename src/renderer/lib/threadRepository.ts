import { createContext, useContext } from "react"
import type { GitHubRepository } from "../../shared/github.ts"

export const ThreadRepository = createContext<GitHubRepository | null>(null)

export const useThreadRepository = () => useContext(ThreadRepository)
