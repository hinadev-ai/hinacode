import { useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { threadPortsAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx"
import { ComputerIcon } from "../icons/ComputerIcon.tsx"
import { GlobeIcon } from "../icons/GlobeIcon.tsx"
import { PhoneIcon } from "../icons/PhoneIcon.tsx"
import { TabletIcon } from "../icons/TabletIcon.tsx"
import { WarningIcon } from "../icons/WarningIcon.tsx"

export interface Device {
  readonly name: string
  readonly width: number
  readonly height: number
}

const DEVICES = {
  phone: [
    { name: "iPhone SE", width: 375, height: 667 },
    { name: "iPhone 17", width: 402, height: 874 },
    { name: "iPhone Air", width: 420, height: 912 },
    { name: "iPhone 17 Pro Max", width: 440, height: 956 },
    { name: "Galaxy S25", width: 360, height: 780 },
  ],
  tablet: [
    { name: "iPad mini", width: 744, height: 1133 },
    { name: 'iPad Air 11"', width: 820, height: 1180 },
    { name: 'iPad Pro 13"', width: 1032, height: 1376 },
  ],
} satisfies Record<string, ReadonlyArray<Device>>

const FIT_PANEL = "fit"

export interface Failure {
  readonly url: string
  readonly description: string
}

export function ViewportMenu({
  device,
  onChange,
}: {
  device: Device | null
  onChange: (device: Device | null) => void
}) {
  const devices = [...DEVICES.phone, ...DEVICES.tablet]
  const Icon = device === null ? ComputerIcon : DEVICES.phone.includes(device) ? PhoneIcon : TabletIcon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={m.browser_viewport()}
            title={device?.name ?? m.browser_viewport()}
            className={cn(device && "text-primary")}
          />
        }
      >
        <Icon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-56">
        <DropdownMenuRadioGroup
          value={device?.name ?? FIT_PANEL}
          onValueChange={(name: string) => onChange(devices.find((each) => each.name === name) ?? null)}
        >
          <DropdownMenuRadioItem value={FIT_PANEL} closeOnClick>
            {m.browser_viewport_responsive()}
          </DropdownMenuRadioItem>
          <DeviceGroup label={m.browser_viewport_mobile()} devices={DEVICES.phone} />
          <DeviceGroup label={m.browser_viewport_tablet()} devices={DEVICES.tablet} />
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DeviceGroup({ label, devices }: { label: string; devices: ReadonlyArray<Device> }) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {devices.map((device) => (
          <DropdownMenuRadioItem key={device.name} value={device.name} closeOnClick>
            {device.name}
            <span className="ml-auto pl-4 font-mono text-xs text-muted-foreground tabular-nums">
              {device.width}×{device.height}
            </span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuGroup>
    </>
  )
}

export function BrowserStart({
  threadId,
  onOpen,
  hint = m.browser_start_hint(),
}: {
  threadId: string
  onOpen: (url: string) => void
  hint?: string
}) {
  const ports = AsyncResult.getOrElse(useAtomValue(threadPortsAtom(threadId)), () => [])
  const unique = [...new Map(ports.map((port) => [port.port, port])).values()]
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <GlobeIcon aria-hidden className="size-6 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{m.browser_start_title()}</h3>
        <p className="max-w-64 text-xs text-pretty text-muted-foreground">{hint}</p>
      </div>
      {unique.length > 0 && (
        <ul className="flex w-full max-w-72 flex-col gap-1">
          {unique.map((port) => (
            <li key={port.port}>
              <Button
                variant="outline"
                size="sm"
                aria-label={m.browser_start_open_port({ port: String(port.port) })}
                onClick={() => onOpen(`http://localhost:${port.port}/`)}
                className="w-full justify-between font-normal"
              >
                <span className="font-mono">localhost:{port.port}</span>
                <span className="truncate text-muted-foreground">{port.command}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function LoadFailure({ failure, onRetry }: { failure: Failure; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center"
    >
      <WarningIcon aria-hidden className="size-6 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium break-all">{m.browser_load_failed({ url: failure.url })}</p>
        <p className="font-mono text-xs text-muted-foreground">{failure.description}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {m.sidebar_retry()}
      </Button>
    </div>
  )
}
