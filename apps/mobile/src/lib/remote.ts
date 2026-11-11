import { Cause, Effect } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity"
import type { PushEvent, RpcMethod, RpcRequest } from "@shared/contract.ts"
import { onEvent, request, RpcError, useConnection } from "./connection"
import { errorText } from "./error-text"

export const registry = AtomRegistry.make()

export const familyOf = <Args extends ReadonlyArray<unknown>, A extends object>(make: (...args: Args) => A) => {
  const family = Atom.family((key: string) => make(...(JSON.parse(key) as Args)))
  return (...args: Args) => family(JSON.stringify(args))
}

export const handshakes = Atom.readable((get) => {
  get.addFinalizer(
    useConnection.subscribe((state, previous) => {
      if (state.generation !== previous.generation) get.setSelf(state.generation)
    }),
  )
  return useConnection.getState().generation
})

export const beforeFirstHandshake = (get: Atom.AtomContext) => get(handshakes) === 0

export const loaderFamily = <Args extends ReadonlyArray<unknown>>(load: (...args: Args) => Promise<unknown>) =>
  familyOf((...args: Args) =>
    Atom.make((get) => {
      if (beforeFirstHandshake(get)) return Effect.never
      return Effect.ignore(Effect.tryPromise(() => load(...args)))
    }),
  )

export const rpcFamily =<M extends RpcMethod>(
  method: M,
  options: { readonly refreshOn?: (event: PushEvent, payload: RpcRequest<M>) => boolean } = {},
) =>
  familyOf((payload: RpcRequest<M>, server?: string | null) =>
    Atom.make((get) => {
      if (beforeFirstHandshake(get)) return Effect.never
      const { refreshOn } = options
      if (refreshOn !== undefined)
        get.addFinalizer(onEvent((event) => refreshOn(event, payload) && get.refreshSelf()))
      return request(method, payload, server ? { server } : undefined)
    }),
  )

export const reportFailure =
  (report: (message: string) => void) => (result: AsyncResult.AsyncResult<unknown, unknown>) => {
    if (AsyncResult.isFailure(result) && !result.waiting) report(errorText(Cause.squash(result.cause)))
  }

export type Loaded<T> = { readonly value: T } | { readonly error: string; readonly tag?: string }

export const failureOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return { error: errorText(error), tag: error instanceof RpcError ? error.tag : undefined }
}

export function asLoaded<T>(result: AsyncResult.AsyncResult<T, RpcError>): Loaded<T> | null {
  if (AsyncResult.isSuccess(result)) return { value: result.value }
  if (AsyncResult.isInitial(result) || result.waiting) return null
  return failureOf(result.cause)
}
