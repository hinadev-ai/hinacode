import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { ReactNode } from "react"
import { RiGlobalLine } from "react-icons/ri"
import { faviconAtom } from "../lib/rpc.ts"

/** Whether `href` is a web url, the only kind that gets a favicon. */
export const isWebUrl = (href: string | undefined): href is string => /^https?:\/\//i.test(href ?? "")

const originOf = (href: string) => URL.parse(href)?.origin ?? ""

function Favicon({ origin }: { origin: string }) {
  const icon = AsyncResult.getOrElse(useAtomValue(faviconAtom(origin)), () => null)
  // Both branches are the same size, so the text does not shift when the icon arrives.
  return icon ? (
    <img src={icon} alt="" aria-hidden className="mr-1 inline-block size-3.5 rounded-sm align-[-0.125em]" />
  ) : (
    <RiGlobalLine aria-hidden className="mr-1 inline-block size-3.5 align-[-0.125em] text-muted-foreground" />
  )
}

/**
 * A link that opens in the system browser with its site's favicon in front. A bare url (text equal to
 * its href) is shown without a trailing slash.
 */
export function WebLink({ href, children }: { href: string; children: ReactNode }) {
  const label = children === href ? href.replace(/\/$/, "") : children
  return (
    // target=_blank routes the click through the main process, which opens it in the system browser.
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      <Favicon origin={originOf(href)} />
      {label}
    </a>
  )
}
