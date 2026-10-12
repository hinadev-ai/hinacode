import type { Page } from "@playwright/test"
import type { RpcEnvelope, RpcMethod, RpcRequestEncoded, RpcResponseEncoded } from "../../src/shared/contract.ts"

/**
 * Calls main the way the renderer does, through the preload bridge. Use it to seed state whose
 * creation is not under test and to read side effects back; drive the behavior under test through
 * the UI.
 */
export const rpc = async <M extends RpcMethod>(
  page: Page,
  method: M,
  payload: RpcRequestEncoded<M>,
): Promise<RpcResponseEncoded<M>> => {
  const envelope = (await page.evaluate(([name, input]) => window.kkcode.rpc(name, input), [
    method,
    payload,
  ] as const)) as RpcEnvelope<RpcResponseEncoded<M>>
  if ("error" in envelope) throw new Error(`${method} failed: ${envelope.error.tag}: ${envelope.error.message}`)
  return envelope.result
}
