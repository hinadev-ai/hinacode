import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { ReactNode } from "react"
import {
  diskFullness,
  type DiskUsage,
  isThreadBusy,
  type MachineResources,
  type Project,
  type ResourceSample,
} from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { type Cloud, environmentOf, useClouds, useCloudStateText } from "../lib/environments.ts"
import { type EnvironmentId, machineResourcesAtom, projectsAtom, RpcError } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { Button } from "./ui/button.tsx"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./ui/popover.tsx"
import { Skeleton } from "./ui/skeleton.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"
import { CloudIcon } from "./icons/CloudIcon.tsx"
import { CloudOffIcon } from "./icons/CloudOffIcon.tsx"
import { ComputerIcon } from "./icons/ComputerIcon.tsx"
import { GaugeIcon } from "./icons/GaugeIcon.tsx"

const WINDOW_MS = 10 * 60 * 1000
const HOT = 0.9
const GIB = 2 ** 30

const percent = (value: number) =>
  new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 0 }).format(value)

const oneDecimal = (value: number) =>
  new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)

const gigabytes = (bytes: number) =>
  new Intl.NumberFormat(getLocale(), {
    style: "unit",
    unit: "gigabyte",
    maximumFractionDigits: bytes >= 100 * GIB ? 0 : 1,
  }).format(bytes / GIB)

export function MachineResourcesButton() {
  const open = useUi((state) => state.resourcesOpen)
  const setOpen = useUi((state) => state.setResourcesOpen)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label={m.resources_title()} />}>
              <GaugeIcon aria-hidden />
            </PopoverTrigger>
          }
        />
        <TooltipContent side="bottom">{m.resources_title()}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-[36rem] max-w-[calc(100vw-1rem)] gap-0 p-0">
        <PopoverHeader className="px-3 pt-3 pb-2">
          <PopoverTitle>{m.resources_title()}</PopoverTitle>
          <PopoverDescription className="text-xs">{m.resources_description()}</PopoverDescription>
        </PopoverHeader>
        <MachineTable />
      </PopoverContent>
    </Popover>
  )
}

function MachineTable() {
  const clouds = useClouds()
  return (
    <div className="max-h-[min(28rem,70vh)] overflow-y-auto pb-1">
      <table className="w-full table-fixed text-xs tabular-nums">
        <colgroup>
          <col />
          <col className="w-34" />
          <col className="w-34" />
          <col className="w-28" />
        </colgroup>
        <thead className="text-2xs text-muted-foreground">
          <tr>
            <th scope="col" className="pb-1 pl-3 text-left font-normal">
              {m.resources_machine()}
            </th>
            <th scope="col" className="pr-3 pb-1 text-right font-normal">
              {m.resources_cpu()}
            </th>
            <th scope="col" className="pr-3 pb-1 text-right font-normal">
              {m.resources_memory()}
            </th>
            <th scope="col" className="pr-3 pb-1 text-right font-normal">
              {m.resources_disk()}
            </th>
          </tr>
        </thead>
        <tbody>
          <MachineRow
            environment={null}
            name={m.environment_this_machine()}
            icon={<ComputerIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
          >
            <Readings environment={null} cloudName={null} />
          </MachineRow>
          {clouds.map((cloud) => (
            <CloudRow key={cloud.id} cloud={cloud} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CloudRow({ cloud }: { cloud: Cloud }) {
  const state = useCloudStateText(cloud)
  const Icon = state === null ? CloudIcon : CloudOffIcon
  const needsYou = cloud.status === "unauthorized" || cloud.status === "incompatible"
  return (
    <MachineRow
      environment={cloud.id}
      name={cloud.name}
      icon={<Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
    >
      {state === null ? (
        <Readings environment={cloud.id} cloudName={cloud.name} />
      ) : (
        <Message attention={needsYou}>{state}</Message>
      )}
    </MachineRow>
  )
}

function useWorkingCount(environment: EnvironmentId) {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), (): ReadonlyArray<Project> => [])
  const here = new Set(projects.filter((project) => environmentOf(project) === environment).map(({ id }) => id))
  return useThreads(
    (state) =>
      Object.values(state.byId).filter((thread) => here.has(thread.projectId) && isThreadBusy(thread.status)).length,
  )
}

function MachineRow({
  environment,
  name,
  icon,
  children,
}: {
  environment: EnvironmentId
  name: string
  icon: ReactNode
  children: ReactNode
}) {
  const working = useWorkingCount(environment)
  return (
    <tr className="border-t border-border align-top">
      <th scope="row" className="py-2 pr-3 pl-3 text-left font-normal">
        <span className="flex min-w-0 items-center gap-1.5">
          {icon}
          <span className="truncate font-medium" title={name}>
            {name}
          </span>
        </span>
        <span className="block truncate pl-5 text-2xs text-muted-foreground">
          {working === 0 ? m.resources_idle() : m.resources_working({ count: working })}
        </span>
      </th>
      {children}
    </tr>
  )
}

function Readings({ environment, cloudName }: { environment: EnvironmentId; cloudName: string | null }) {
  const result = useAtomValue(machineResourcesAtom(environment))
  return AsyncResult.builder(result)
    .onSuccess((resources) => <ReadingCells resources={resources} />)
    .onError((error) => (
      <Message attention>
        {cloudName !== null && error instanceof RpcError && error.tag === "SchemaError"
          ? m.resources_update_cloud({ name: cloudName })
          : m.resources_failed({ message: errorMessage(error) })}
      </Message>
    ))
    .orElse(() => <LoadingCells />)
}

function Message({ attention = false, children }: { attention?: boolean; children: ReactNode }) {
  return (
    <td colSpan={3} className={cn("py-2 pr-3 text-muted-foreground", attention && "text-attention")}>
      {children}
    </td>
  )
}

function LoadingCells() {
  return (
    <>
      <td className="py-2 pr-3">
        <span className="sr-only">{m.resources_loading()}</span>
        <Skeleton className="h-4" />
      </td>
      <td className="py-2 pr-3">
        <Skeleton className="h-4" />
      </td>
      <td className="py-2 pr-3">
        <Skeleton className="h-4" />
      </td>
    </>
  )
}

function ReadingCells({ resources }: { resources: MachineResources }) {
  const { samples, cpuCount, memoryTotal, disks } = resources
  const latest = samples.at(-1)
  const memory = (sample: ResourceSample) => sample.memoryUsed / memoryTotal
  const cores = m.resources_cores({ count: cpuCount })
  return (
    <>
      <Reading
        reading={
          latest && {
            value: latest.cpu,
            detail: latest.load === null ? cores : m.resources_cpu_detail({ load: oneDecimal(latest.load), cores }),
          }
        }
        trend={<Sparkline samples={samples} value={(sample) => sample.cpu} />}
      />
      <Reading
        reading={
          latest && {
            value: memory(latest),
            detail: m.resources_memory_detail({ used: gigabytes(latest.memoryUsed), total: gigabytes(memoryTotal) }),
          }
        }
        trend={<Sparkline samples={samples} value={memory} />}
      />
      <td className="py-2 pr-3 text-right">
        {disks.map((disk) => (
          <DiskReading key={disk.path} disk={disk} named={disks.length > 1} />
        ))}
      </td>
    </>
  )
}

function Reading({
  reading,
  trend,
}: {
  reading: { readonly value: number; readonly detail: string } | undefined
  trend: ReactNode
}) {
  const hot = reading !== undefined && reading.value >= HOT
  return (
    <td className={cn("py-2 pr-3 text-right", hot ? "text-attention" : "text-muted-foreground")}>
      <span className="flex items-center justify-end gap-2">
        {trend}
        <span className={cn("w-9 font-medium", !hot && "text-foreground")}>
          {reading === undefined ? "–" : percent(reading.value)}
        </span>
      </span>
      <span className="block truncate text-2xs text-muted-foreground">
        {reading === undefined ? m.resources_sampling() : reading.detail}
      </span>
    </td>
  )
}

function DiskReading({ disk, named }: { disk: DiskUsage; named: boolean }) {
  const share = diskFullness(disk)
  const hot = share >= HOT
  const free = gigabytes(disk.free)
  return (
    <span className="block">
      <span className="flex items-center justify-end gap-2">
        <span aria-hidden className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
          <span
            className={cn("block h-full rounded-full", hot ? "bg-attention" : "bg-muted-foreground")}
            style={{ width: `${share * 100}%` }}
          />
        </span>
        <span className={cn("w-9 font-medium", hot && "text-attention")}>{percent(share)}</span>
      </span>
      <span className="block truncate text-2xs text-muted-foreground" title={disk.path}>
        {named ? m.resources_disk_free_on({ free, path: disk.path }) : m.resources_disk_free({ free })}
      </span>
    </span>
  )
}

const SPARK_WIDTH = 56
const SPARK_HEIGHT = 18

function Sparkline({
  samples,
  value,
}: {
  samples: ReadonlyArray<ResourceSample>
  value: (sample: ResourceSample) => number
}) {
  const end = samples.at(-1)?.at ?? 0
  const points = samples
    .map((sample) => {
      const x = SPARK_WIDTH * (1 - (end - sample.at) / WINDOW_MS)
      const y = SPARK_HEIGHT - 1 - (SPARK_HEIGHT - 2) * Math.min(1, Math.max(0, value(sample)))
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(" ")
  return (
    <svg aria-hidden viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} className="h-4.5 w-14 shrink-0 overflow-visible">
      <line
        x1={0}
        x2={SPARK_WIDTH}
        y1={SPARK_HEIGHT - 0.5}
        y2={SPARK_HEIGHT - 0.5}
        className="stroke-border"
        strokeDasharray="1 2"
      />
      {samples.length > 1 && (
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  )
}
