import type { CSSProperties } from "react"
import { RiCloseLine } from "react-icons/ri"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { m } from "@/paraglide/messages.js"
import { AlertIcon, CheckCircleIcon, InfoIcon, SpinnerIcon, XCircleIcon } from "@hinacode/icons"

const Toaster = (props: ToasterProps) => (
  <Sonner
    className="group"
    closeButton
    toastOptions={{ closeButtonAriaLabel: m.common_close() }}
    icons={{
      success: <CheckCircleIcon className="size-4" />,
      info: <InfoIcon className="size-4" />,
      warning: <AlertIcon className="size-4 text-attention" />,
      error: <XCircleIcon className="size-4 text-destructive" />,
      loading: <SpinnerIcon className="size-4 animate-spin motion-reduce:animate-none" />,
      close: <RiCloseLine className="size-3" />,
    }}
    style={
      {
        "--normal-bg": "var(--popover)",
        "--normal-text": "var(--popover-foreground)",
        "--normal-border": "var(--color-border)",
        "--border-radius": "var(--radius)",
        "--toast-close-button-start": "unset",
        "--toast-close-button-end": "0",
        "--toast-close-button-transform": "translate(35%, -35%)",
        fontFamily: "inherit",
      } as CSSProperties
    }
    {...props}
  />
)

export { Toaster }
