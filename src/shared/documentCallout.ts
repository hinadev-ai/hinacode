export const CALLOUT_TONES = ["note", "tip", "important", "warning", "caution"] as const

export type CalloutTone = (typeof CALLOUT_TONES)[number]

const MARKER = /^\s*\[!(note|tip|important|warning|caution)\]\s*$/i

export const isCalloutTone = (value: unknown): value is CalloutTone => CALLOUT_TONES.some((tone) => tone === value)

export const calloutTone = (value: unknown): CalloutTone => (isCalloutTone(value) ? value : "note")

export const calloutMarker = (tone: CalloutTone) => `[!${tone.toUpperCase()}]`

export const splitCalloutMarker = (paragraph: string): { tone: CalloutTone; rest: string } | null => {
  const [first = "", ...rest] = paragraph.split("\n")
  const tone = MARKER.exec(first)?.[1]?.toLowerCase()
  return isCalloutTone(tone) ? { tone, rest: rest.join("\n") } : null
}
