import { cn } from "cn"
import { useEffect, useState } from "react"
import { RiCheckLine, RiFileCopyLine } from "react-icons/ri"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"

const iconSwap = "absolute inset-0 transition-[opacity,scale,filter] duration-200 ease-swap"
const iconShown = "opacity-100"
const iconHidden = "opacity-0 motion-safe:scale-25 motion-safe:blur-xs"

interface CopyButtonProps {
  readonly value: string
  readonly label: string
  readonly variant?: "ghost" | "outline"
  readonly className?: string
}

export function CopyButton({ value, label, variant = "ghost", className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const title = copied ? m.common_copied() : label
  return (
    <Button
      type="button"
      variant={variant}
      size="icon-sm"
      aria-label={title}
      title={title}
      onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
      className={className}
    >
      <span aria-hidden className="relative size-4">
        <RiFileCopyLine className={cn(iconSwap, copied ? iconHidden : iconShown)} />
        <RiCheckLine className={cn(iconSwap, "text-success", copied ? iconShown : iconHidden)} />
      </span>
      <output className="sr-only">{copied ? m.common_copied() : ""}</output>
    </Button>
  )
}
