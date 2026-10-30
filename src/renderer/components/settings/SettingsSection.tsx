import { cn } from "cn"
import { type ComponentProps, createContext, type ReactNode, use, useId } from "react"
import { createPortal } from "react-dom"

interface SettingsSectionProps {
  readonly title?: string
  readonly description?: string
  readonly action?: ReactNode
  readonly children: ReactNode
}

export function SettingsSection({ title, description, action, children }: SettingsSectionProps) {
  const headingId = useId()
  return (
    <section aria-labelledby={title === undefined ? undefined : headingId} className="flex flex-col gap-4">
      {(title !== undefined || description !== undefined || action !== undefined) && (
        <header className="flex items-start gap-4">
          <div className="flex flex-1 flex-col gap-1">
            {title !== undefined && (
              <h2 id={headingId} className="text-base font-semibold">
                {title}
              </h2>
            )}
            {description && <p className="text-xs text-pretty text-muted-foreground">{description}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export const settingsSurfaceClass = "rounded-xl bg-muted dark:bg-muted/50"

export const settingsGroupClass = cn(
  settingsSurfaceClass,
  "flex flex-col px-4 *:py-3 [&>*+*]:border-t [&>*+*]:border-foreground/8",
)

export function SettingsGroup({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn(settingsGroupClass, className)} {...props} />
}

export function SettingsGroupTitle({ className, children, ...props }: ComponentProps<"h3">) {
  return (
    <h3 className={cn("-mb-2 px-1 text-sm font-medium", className)} {...props}>
      {children}
    </h3>
  )
}

const PageActionSlot = createContext<HTMLElement | null>(null)

export const PageActionSlotProvider = PageActionSlot.Provider

export function SettingsPageAction({ children }: { children: ReactNode }) {
  const slot = use(PageActionSlot)
  return slot && createPortal(children, slot)
}
