import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { domToBlob } from "modern-screenshot"
import { useRef, useState } from "react"
import { toast } from "sonner"
import { USAGE_PERIODS, type UsagePeriod, summarizeUsage } from "../../../shared/usage.ts"
import { useSettingsEnvironment } from "../../lib/environments.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { usageRowsAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { Label } from "../ui/label.tsx"
import { Switch } from "../ui/switch.tsx"
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.tsx"
import { UsageCard } from "../UsageCard.tsx"
import { RiDownload2Line } from "react-icons/ri"
import { CopyIcon } from "@hinacode/icons"

const EXPORT_WIDTH_PX = 2400

const periodTab = {
  "7d": m.usage_period_7d,
  "30d": m.usage_period_30d,
  all: m.usage_period_all,
} satisfies Record<UsagePeriod, () => string>

const maskProject = (rank: number) => m.usage_project_masked({ rank: String(rank) })

const renderPng = (card: HTMLElement) =>
  domToBlob(card, { type: "image/png", scale: EXPORT_WIDTH_PX / card.offsetWidth }).then((blob) => {
    if (blob === null) throw new Error("The card could not be drawn.")
    return blob
  })

const savePng = async (card: HTMLElement, period: UsagePeriod) => {
  const url = URL.createObjectURL(await renderPng(card))
  const link = document.createElement("a")
  link.href = url
  link.download = `hinacode-usage-${period}.png`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

const copyPng = async (card: HTMLElement) => {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": renderPng(card) })])
  toast(m.common_copied())
}

export function UsageSettings() {
  const environment = useSettingsEnvironment()
  const [period, setPeriod] = useState<UsagePeriod>("30d")
  const [showProjects, setShowProjects] = useState(false)
  const rows = useAtomValue(usageRowsAtom(environment, period))
  const refresh = useAtomRefresh(usageRowsAtom(environment, period))
  const cardRef = useRef<HTMLElement>(null)

  const exporting = (run: (card: HTMLElement) => Promise<void>) => async () => {
    const card = cardRef.current
    if (!card) return
    try {
      await run(card)
    } catch (cause) {
      toast.error(errorMessage(cause))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Tabs value={period} changeAction={(value: UsagePeriod) => setPeriod(value)}>
          <TabsList aria-label={m.usage_period()}>
            {USAGE_PERIODS.map((value) => (
              <TabsTrigger key={value} value={value} className="px-3">
                {periodTab[value]()}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <Switch id="usage-show-projects" checked={showProjects} onCheckedChange={setShowProjects} />
          <Label htmlFor="usage-show-projects">{m.usage_show_projects()}</Label>
        </div>
        <div className="ms-auto flex items-center gap-2">
          <Button variant="outline" size="sm" action={exporting(copyPng)}>
            <CopyIcon aria-hidden />
            {m.usage_copy_image()}
          </Button>
          <Button size="sm" action={exporting((card) => savePng(card, period))}>
            <RiDownload2Line aria-hidden />
            {m.usage_save_png()}
          </Button>
        </div>
      </div>
      <div className="@container overflow-hidden rounded-lg border border-border">
        {AsyncResult.builder(rows)
          .onSuccess((loaded) => (
            <UsageCard
              ref={cardRef}
              period={period}
              summary={summarizeUsage(loaded, showProjects ? {} : { maskProject })}
            />
          ))
          .onError((cause) => (
            <div role="alert" className="flex flex-col items-start gap-2">
              <p className="text-sm text-destructive">{errorMessage(cause)}</p>
              <Button variant="outline" size="sm" onClick={refresh}>
                {m.common_retry()}
              </Button>
            </div>
          ))
          .orElse(() => (
            <div className="aspect-video w-full rounded-lg bg-muted" />
          ))}
      </div>
    </div>
  )
}
