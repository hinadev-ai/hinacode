import type { CSSProperties } from "react"
import { RiAlertLine, RiCheckboxCircleLine, RiCloseCircleLine, RiInformationLine, RiLoader4Line } from "react-icons/ri"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/** Colors only the icon, so a toast reads as calm surface plus one status signal. */
const Toaster = (props: ToasterProps) => (
  <Sonner
    className="toaster group"
    icons={{
      success: <RiCheckboxCircleLine className="size-4" />,
      info: <RiInformationLine className="size-4" />,
      warning: <RiAlertLine className="size-4 text-attention" />,
      error: <RiCloseCircleLine className="size-4 text-destructive" />,
      loading: <RiLoader4Line className="size-4 animate-spin motion-reduce:animate-none" />,
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
