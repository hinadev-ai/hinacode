import { codeHostOfUrl, mergeMethodsFor, offeredMergeMethod } from "@shared/codeHost.ts"
import type { MergeMethod } from "@shared/domain.ts"

export const mergeChoice = (url: string, chosen: MergeMethod) => {
  const methods = mergeMethodsFor(codeHostOfUrl(url))
  return { methods, method: offeredMergeMethod(chosen, methods) }
}
