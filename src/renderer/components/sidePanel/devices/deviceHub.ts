import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type DeviceCheck, platformReady } from "../../../../shared/device.ts"
import { useClouds, useThreadEnvironment } from "../../../lib/environments.ts"
import { useSettings } from "../../../lib/settings.ts"
import { m } from "../../../paraglide/messages.js"

export interface DeviceHub {
  readonly name: string
  readonly offline: boolean
}

export function useDeviceHub(threadId: string): DeviceHub | null {
  const local = useThreadEnvironment(threadId) === null
  const hubId = useSettings(null).experimental.devicesOn
  const clouds = useClouds()
  if (!local || hubId === null) return null
  const cloud = clouds.find((each) => each.id === hubId)
  return { name: cloud?.name ?? hubId, offline: cloud?.status !== "connected" }
}

export const lastValue = <A, E>(result: AsyncResult.AsyncResult<A, E>): A | undefined => {
  if (AsyncResult.isSuccess(result)) return result.value
  if (AsyncResult.isFailure(result)) return Option.getOrUndefined(result.previousSuccess)?.value
  return undefined
}

export const readinessSummary = (checks: ReadonlyArray<DeviceCheck>) => {
  const ios = platformReady(checks, "ios")
  const android = platformReady(checks, "android")
  const platforms =
    ios && android
      ? m.devices_summary_both()
      : ios
        ? m.devices_summary_ios()
        : android
          ? m.devices_summary_android()
          : m.devices_summary_none()
  const steps = checks.filter((check) => check.needed !== "recommended" && check.state === "missing").length
  return steps === 0
    ? platforms
    : m.devices_summary_with_steps({ platforms, steps: m.devices_summary_steps({ count: steps }) })
}
