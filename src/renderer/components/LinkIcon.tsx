import type { ReactNode } from "react"

const firstGrapheme = (text: string) =>
  new Intl.Segmenter().segment(text)[Symbol.iterator]().next().value?.segment ?? ""

export function WithLinkIcon({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  // FIXME: Tailwind Typography gives every <img> block margins, which would push the line apart
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
