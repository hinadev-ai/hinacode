import { stat, statfs } from "node:fs/promises"
import { cpus, loadavg, totalmem } from "node:os"
import { Clock, Context, Effect, Layer } from "effect"
import { diskFullness, type DiskUsage, type MachineResources, type ResourceSample } from "../../shared/domain.ts"

const INTERVAL = "5 seconds"
const KEPT_SAMPLES = 120

export class SystemResources extends Context.Service<
  SystemResources,
  { readonly read: (paths: ReadonlyArray<string>) => Effect.Effect<MachineResources> }
>()("hinacode/SystemResources") {}

const cpuTimes = () =>
  cpus().reduce(
    (sum, { times }) => {
      const busy = times.user + times.nice + times.sys + times.irq
      return { busy: sum.busy + busy, total: sum.total + busy + times.idle }
    },
    { busy: 0, total: 0 },
  )

const memoryTotal = () => {
  const constrained = process.constrainedMemory()
  return constrained > 0 && constrained < totalmem() ? constrained : totalmem()
}

const diskOf = (path: string) =>
  Effect.tryPromise(async () => {
    const [{ dev }, disk] = await Promise.all([stat(path), statfs(path)])
    const used = (disk.blocks - disk.bfree) * disk.bsize
    return { dev, disk: { path, used, free: disk.bavail * disk.bsize } }
  }).pipe(Effect.option)

const disksUnder = (paths: ReadonlyArray<string>) =>
  Effect.forEach(
    [...new Set(paths)].toSorted((a, b) => a.length - b.length),
    diskOf,
    {
      concurrency: "unbounded",
    },
  ).pipe(
    Effect.map((found) => {
      const byDevice = new Map<number, DiskUsage>()
      for (const entry of found) {
        if (entry._tag === "Some" && !byDevice.has(entry.value.dev)) byDevice.set(entry.value.dev, entry.value.disk)
      }
      return [...byDevice.values()].toSorted((a, b) => diskFullness(b) - diskFullness(a))
    }),
  )

const make = Effect.gen(function* () {
  let samples: ReadonlyArray<ResourceSample> = []
  let last = cpuTimes()

  const sample = Effect.gen(function* () {
    const now = cpuTimes()
    const total = now.total - last.total
    const cpu = total > 0 ? Math.min(1, Math.max(0, (now.busy - last.busy) / total)) : 0
    last = now
    const memoryUsed = Math.max(0, memoryTotal() - process.availableMemory())
    const load = process.platform === "win32" ? null : (loadavg()[0] ?? null)
    const at = yield* Clock.currentTimeMillis
    samples = [...samples.slice(1 - KEPT_SAMPLES), { at, cpu, memoryUsed, load }]
  })

  yield* sample.pipe(Effect.delay(INTERVAL), Effect.forever, Effect.forkScoped)

  const read = (paths: ReadonlyArray<string>) =>
    Effect.map(disksUnder(paths), (disks) => ({
      cpuCount: cpus().length,
      memoryTotal: memoryTotal(),
      samples,
      disks,
    }))

  return SystemResources.of({ read })
})

export const layer = Layer.effect(SystemResources, make)
