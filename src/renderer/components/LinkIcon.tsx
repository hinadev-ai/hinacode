import type { ReactNode } from "react"

const firstGrapheme = (text: string) =>
  new Intl.Segmenter().segment(text)[Symbol.iterator]().next().value?.segment ?? ""

/**
 * A link's text with an icon in front. The icon box is one em, so it follows the text size, and the icon fills it.
 * The icon stays on one line with the text's first character, so a wrapping link never leaves it alone at a line end.
 */
export function WithLinkIcon({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  // `not-prose`: markdown's prose styles give every <img> block margins, which would push the line apart.
  const box = (
    <span aria-hidden className="not-prose me-[0.25em] inline-flex size-[1em] align-[-0.125em]">
      {icon}
    </span>
  )
  if (typeof children !== "string") {
    return (
      <>
        {box}
        {children}
      </>
    )
  }
  const first = firstGrapheme(children)
  return (
    <>
      <span className="whitespace-nowrap">
        {box}
        {first}
      </span>
      {children.slice(first.length)}
    </>
  )
}
