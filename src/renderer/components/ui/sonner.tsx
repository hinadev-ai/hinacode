import type { CSSProperties } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { AlertIcon } from "../icons/AlertIcon.tsx"
import { CheckCircleIcon } from "../icons/CheckCircleIcon.tsx"
import { InfoIcon } from "../icons/InfoIcon.tsx"
import { SpinnerIcon } from "../icons/SpinnerIcon.tsx"
import { XCircleIcon } from "../icons/XCircleIcon.tsx"

const Toaster = (props: ToasterProps) => (
  <Sonner
    className="group"
    icons={{
      success: <CheckCircleIcon className="size-4" />,
      info: <InfoIcon className="size-4" />,
      warning: <AlertIcon className="size-4 text-attention" />,
      error: <XCircleIcon className="size-4 text-destructive" />,
      loading: <SpinnerIcon className="size-4 animate-spin motion-reduce:animate-none" />,
    }}
    style={
      {
        "--normal-bg": "var(--popover)",
        "--normal-text": "var(--popover-foreground)",
        "--normal-border": "var(--color-border)",
        "--border-radius": "var(--radius)",
        fontFamily: "inherit",
      } as CSSProperties
    }
    {...props}
  />
)

export { Toaster }
