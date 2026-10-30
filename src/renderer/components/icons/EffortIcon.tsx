const bars = [
  { x: 0.5, width: 3.1, height: 7 },
  { x: 4.35, width: 3.1, height: 9.5 },
  { x: 8.2, width: 3.1, height: 12 },
  { x: 12.05, width: 3.1, height: 14.5 },
  { x: 15.9, width: 3.1, height: 17 },
  { x: 19.75, width: 3.75, height: 21 },
]

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
