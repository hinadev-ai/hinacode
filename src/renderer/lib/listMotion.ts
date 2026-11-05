import type { AutoAnimationPlugin } from "@formkit/auto-animate"

const easeOut = "cubic-bezier(0.23, 1, 0.32, 1)"
const easeInOut = "cubic-bezier(0.77, 0, 0.175, 1)"

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches

export const listMotionPausedWhile =
  (paused: () => boolean): AutoAnimationPlugin =>
  (el, action, coords, nextCoords) => {
    if (paused()) return new KeyframeEffect(el, [], { duration: 0 })
    const reduced = reducedMotion()
    if (action === "add")
      return new KeyframeEffect(
        el,
        reduced
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { opacity: 0, transform: "scale(0.98)" },
              { opacity: 1, transform: "scale(1)" },
            ],
        { duration: 150, easing: easeOut },
      )
    if (action === "remove")
      return new KeyframeEffect(
        el,
        reduced
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { opacity: 1, transform: "scale(1)" },
              { opacity: 0, transform: "scale(0.98)" },
            ],
        { duration: 100, easing: easeOut },
      )
    if (reduced || coords === undefined || nextCoords === undefined) return new KeyframeEffect(el, [], { duration: 0 })
    const dx = coords.left - nextCoords.left
    const dy = coords.top - nextCoords.top
    return new KeyframeEffect(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
      duration: 200,
      easing: easeInOut,
    })
  }

export const listMotion = listMotionPausedWhile(() => false)
