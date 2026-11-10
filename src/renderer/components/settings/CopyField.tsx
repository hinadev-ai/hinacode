import { CopyButton } from "../CopyButton.tsx"

export function CopyField({ id, value, copyLabel }: { id: string; value: string; copyLabel: string }) {
  return (
    <div className="flex items-center gap-2">
      <output
        id={id}
        className="min-w-0 flex-1 rounded-lg border border-input bg-muted/40 px-2.5 py-1.5 font-mono text-xs break-all"
        title={value}
      >
        {value}
      </output>
      <CopyButton value={value} label={copyLabel} variant="outline" />
    </div>
  )
}
