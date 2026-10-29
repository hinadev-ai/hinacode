const bars = [
  { x: 0.5, width: 3.1, height: 7 },
  { x: 4.35, width: 3.1, height: 9.5 },
  { x: 8.2, width: 3.1, height: 12 },
  { x: 12.05, width: 3.1, height: 14.5 },
  { x: 15.9, width: 3.1, height: 17 },
  { x: 19.75, width: 3.75, height: 21 },
]

/**
 * Rising bars for reasoning effort, the last one wider for the strongest. `value` is the effort's share of the
 * model's scale, from 0 to 1; it fills that share of the bars, at least one when above 0, and dims the rest.
 * Drawn in `currentColor` on Remix's 24-unit grid.
 */
export function EffortIcon({ value, className }: { value: number; className?: string }) {
  const filled = value <= 0 ? 0 : Math.max(1, Math.round(value * bars.length))
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      {bars.map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={22 - bar.height}
          width={bar.width}
          height={bar.height}
          rx={0.75}
          opacity={index < filled ? 1 : 0.25}
        />
      ))}
    </svg>
  )
}
