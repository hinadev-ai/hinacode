import { Effect } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import type { PushEvent, RpcMethod, RpcRequest } from "@shared/contract.ts"
import { onEvent, request, useConnection } from "./connection"

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

export const loaderFamily = <Args extends ReadonlyArray<unknown>>(load: (...args: Args) => Promise<unknown>) =>
  familyOf((...args: Args) =>
    Atom.make((get) => {
      get(handshakes)
      return Effect.ignore(Effect.tryPromise(() => load(...args)))
    }),
  )

export const rpcFamily =<M extends RpcMethod>(
  method: M,
  options: { readonly refreshOn?: (event: PushEvent, payload: RpcRequest<M>) => boolean } = {},
) =>
  familyOf((payload: RpcRequest<M>, server?: string | null) =>
    Atom.make((get) => {
      get(handshakes)
      const { refreshOn } = options
      if (refreshOn !== undefined)
        get.addFinalizer(onEvent((event) => refreshOn(event, payload) && get.refreshSelf()))
      return request(method, payload, server ? { server } : undefined)
    }),
  )
