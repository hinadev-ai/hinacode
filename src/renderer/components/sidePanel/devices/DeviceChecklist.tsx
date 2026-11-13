import { cn } from "cn"
import {
  type DeviceCheck,
  type DevicePlatform,
  type Requirement,
  requirementPlatform,
} from "../../../../shared/device.ts"
import { m } from "../../../paraglide/messages.js"
import { CopyButton } from "../../CopyButton.tsx"
import { Button } from "../../ui/button.tsx"
import { useVmAction } from "../TinyVmView.tsx"
import { CheckIcon, CircleIcon, WarningIcon } from "@hinacode/icons"

interface RequirementCopy {
  readonly name: () => string
  readonly purpose: () => string
  readonly instruction?: () => string
  readonly command?: string
  readonly installLabel?: () => string
}

const requirementCopy: Record<Requirement, RequirementCopy> = {
  xcode: {
    name: m.devices_check_xcode,
    purpose: m.devices_check_xcode_for,
    instruction: m.devices_check_xcode_fix,
    command: "sudo xcode-select -s /Applications/Xcode.app",
  },
  iosRuntime: { name: m.devices_check_ios_runtime, purpose: m.devices_check_ios_runtime_for },
  simslim: { name: m.devices_check_simslim, purpose: m.devices_check_simslim_for },
  axe: { name: m.devices_check_axe, purpose: m.devices_check_axe_for },
  androidSdk: {
    name: m.devices_check_android_sdk,
    purpose: m.devices_check_android_sdk_for,
    instruction: m.devices_check_android_sdk_fix,
  },
  androidImage: { name: m.devices_check_android_image, purpose: m.devices_check_android_image_for },
  avd: { name: m.devices_check_avd, purpose: m.devices_check_avd_for, installLabel: m.devices_check_create },
  audioCapture: {
    name: m.devices_check_audio_capture,
    purpose: m.devices_check_audio_capture_for,
    instruction: m.devices_check_audio_capture_fix,
  },
}

const platformName: Record<DevicePlatform, () => string> = { ios: m.devices_ios, android: m.devices_android }

interface DeviceChecklistProps {
  readonly checks: ReadonlyArray<DeviceCheck>
  readonly platform: DevicePlatform
  readonly rechecking: boolean
  readonly onSetup: (requirement: Requirement) => Promise<void>
  readonly onRecheck: () => void
}

export function DeviceChecklist({ checks, platform, rechecking, onSetup, onRecheck }: DeviceChecklistProps) {
  const rows = checks.filter((check) => requirementPlatform[check.requirement] === platform)
  if (rows.some((check) => check.state === "unsupported")) {
    return <p className="px-3 py-1 text-xs text-pretty">{m.devices_ios_not_mac()}</p>
  }
  if (rows.every((check) => check.state === "ready")) return null
  return (
    <ul aria-label={m.devices_checklist_label({ platform: platformName[platform]() })} className="flex flex-col">
      {rows.map((check) => (
        <CheckRow
          key={check.requirement}
          check={check}
          rechecking={rechecking}
          onSetup={() => onSetup(check.requirement)}
          onRecheck={onRecheck}
        />
      ))}
    </ul>
  )
}

type Tone = "ready" | "missing" | "optional"

const tones: Record<
  Tone,
  { readonly Icon: typeof CheckIcon; readonly className: string; readonly label: () => string }
> = {
  ready: { Icon: CheckIcon, className: "text-success", label: m.devices_check_ready },
  missing: { Icon: WarningIcon, className: "text-destructive", label: m.devices_check_missing },
  optional: { Icon: CircleIcon, className: "text-muted-foreground", label: m.devices_check_not_installed },
}

const toneOf = (check: DeviceCheck): Tone =>
  check.state === "ready" ? "ready" : check.needed === "recommended" ? "optional" : "missing"

interface CheckRowProps {
  readonly check: DeviceCheck
  readonly rechecking: boolean
  readonly onSetup: () => Promise<void>
  readonly onRecheck: () => void
}

function CheckRow({ check, rechecking, onSetup, onRecheck }: CheckRowProps) {
  const { pending, error, run } = useVmAction()
  const copy = requirementCopy[check.requirement]
  const tone = tones[toneOf(check)]
  const ready = check.state === "ready"
  return (
    <li className="flex items-start gap-2 px-3 py-1.5">
      <tone.Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", tone.className)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm">{copy.name()}</span>
          <span className={cn("shrink-0 text-xs", tone.className)}>{tone.label()}</span>
        </div>
        <p className="text-xs text-pretty text-muted-foreground">{copy.purpose()}</p>
        {!ready && check.fix === "manual" && <ManualFix copy={copy} />}
        {error && (
          <p role="alert" className="font-mono text-xs wrap-break-word text-destructive">
            {error}
          </p>
        )}
      </div>
      {!ready && check.fix === "install" && (
        <Button
          variant="outline"
          size="xs"
          disabled={pending}
          aria-label={copy.installLabel ? undefined : m.devices_check_install_label({ name: copy.name() })}
          action={() => run(onSetup)}
        >
          {pending ? m.devices_check_installing() : (copy.installLabel ?? m.devices_check_install)()}
        </Button>
      )}
      {!ready && check.fix === "manual" && (
        <Button variant="outline" size="xs" disabled={rechecking} action={onRecheck}>
          {m.devices_check_again()}
        </Button>
      )}
    </li>
  )
}

function ManualFix({ copy }: { copy: RequirementCopy }) {
  return (
    <>
      {copy.instruction && <p className="text-xs text-pretty">{copy.instruction()}</p>}
      {copy.command && (
        <div className="flex min-w-0 items-center gap-1 text-xs">
          <code className="min-w-0 truncate font-mono">{copy.command}</code>
          <CopyButton value={copy.command} label={m.devices_check_copy()} />
        </div>
      )}
    </>
  )
}
