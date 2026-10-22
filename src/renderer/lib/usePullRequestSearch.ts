import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { matchPullRequests } from "../../shared/composerSyntax.ts"
import type { PullRequestMatch } from "../../shared/domain.ts"
import { pullRequestSearchAtom } from "./rpc.ts"
import { useDebouncedValue } from "./useDebouncedValue.ts"

const DEBOUNCE_MS = 250

const none: ReadonlyArray<PullRequestMatch> = []

/**
 * The project's pull requests for the `#` query being typed, none while `query` is null. GitHub is asked once the
 * query rests for `DEBOUNCE_MS`; until it answers, the last answer narrowed to the query stands in, so the list
 * does not blink on every key. A failed search offers nothing.
 */
export function usePullRequestSearch(projectId: string, query: string | null): ReadonlyArray<PullRequestMatch> {
  const settled = useDebouncedValue(query, DEBOUNCE_MS)
  const result = useAtomValue(pullRequestSearchAtom(projectId, settled))
  const answer = AsyncResult.isSuccess(result) ? result.value : null
  const [last, setLast] = useState(none)
  if (answer !== null && answer !== last) setLast(answer)
  if (query === null) return none
  if (answer !== null && settled === query) return answer
  return matchPullRequests(last, query)
}
