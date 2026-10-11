import { type ReactNode, useId } from "react"

interface SettingsSectionProps {
  readonly title: string
  readonly description?: string
  readonly action?: ReactNode
  readonly children: ReactNode
}

export function SettingsSection({ title, description, action, children }: SettingsSectionProps) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-6">
      <header className="flex items-start gap-4">
        <div className="flex flex-1 flex-col gap-1">
          <h2 id={headingId} className="text-base font-semibold">
            {title}
          </h2>
          {description && <p className="text-sm text-pretty text-muted-foreground">{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}
