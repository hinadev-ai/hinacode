"use client"

import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"
import { ghostButton, paper } from "./surfaces"
import { PlusIcon } from "@hinacode/icons"
import { SendGlyph, type SendGlyphMode } from "../../icons/SendGlyph.tsx"

export function Composer({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="composer" className={cn("relative w-full max-w-lg", className)} {...props} />
}

export function ComposerBar({
  dragActive = false,
  className,
  ...props
}: ComponentProps<"div"> & { dragActive?: boolean }) {
  return (
    <div
      data-slot="composer-bar"
      data-drag-active={dragActive || undefined}
      className={cn(
        paper,
        "flex w-full flex-col gap-2 rounded-[27px] p-2.5 transition-colors",
        dragActive && "bg-blue-500/4 dark:bg-blue-500/10",
        className,
      )}
      {...props}
    />
  )
}

export function ComposerToolbar({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="composer-toolbar" className={cn("flex items-center justify-between", className)} {...props} />
}

export function ComposerActions({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="composer-actions" className={cn("flex items-center gap-1.5", className)} {...props} />
}

export function ComposerAttachButton({ className, ...props }: Omit<ComponentProps<"button">, "children">) {
  return (
    <button
      type="button"
      aria-label="Add attachment"
      data-slot="composer-attach"
      disabled={!props.onClick}
      className={cn(ghostButton, "size-8 disabled:pointer-events-none disabled:opacity-30", className)}
      {...props}
    >
      <PlusIcon className="size-4" />
    </button>
  )
}

export function ComposerSend({
  mode,
  idle,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  mode: SendGlyphMode
  idle: boolean
}) {
  return (
    <button
      type="button"
      data-slot="composer-send"
      className={cn(
        "grid size-8 place-items-center rounded-full",
        mode === "stop" || !idle
          ? "send-halo relative forced-colors:border"
          : "bg-foreground/6 text-muted-foreground inset-ring inset-ring-border transition-colors dark:bg-foreground/9 forced-colors:border forced-colors:border-[GrayText] forced-colors:text-[GrayText]",
        className,
      )}
      {...props}
    >
      <SendGlyph mode={mode} className="size-4" />
    </button>
  )
}
