import type { MergeMethod } from "@shared/domain.ts"

const mergeMethods: readonly MergeMethod[] = ["squash", "merge", "rebase"]

export const mergeChoice = (_url: string, chosen: MergeMethod) => ({ methods: mergeMethods, method: chosen })
