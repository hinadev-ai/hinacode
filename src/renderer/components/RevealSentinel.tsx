const REVEAL_AHEAD = "300px"

export function RevealSentinel({ onReveal }: { onReveal: () => void }) {
  const observe = (sentinel: HTMLDivElement) => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.at(-1)?.isIntersecting) onReveal()
      },
      { root: sentinel.closest("[data-slot=scroll-area-viewport]"), rootMargin: REVEAL_AHEAD },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }
  return <div ref={observe} aria-hidden className="h-px" />
}
