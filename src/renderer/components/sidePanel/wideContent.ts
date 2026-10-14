import { createContext, use, useEffect } from "react"

export const WideContent = createContext<((wide: boolean) => void) | null>(null)

export function useWideContent(open: boolean) {
  const setWide = use(WideContent)
  if (setWide === null) throw new Error("WideContent provider is missing")
  useEffect(() => {
    setWide(open)
    return () => setWide(false)
  }, [open, setWide])
}
