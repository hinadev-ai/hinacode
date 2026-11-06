export const withCode = (text: string) =>
  text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      // oxlint-disable-next-line react/no-array-index-key -- the parts of one fixed sentence never reorder.
      <code key={index} className="font-mono text-[0.85em] text-foreground">
        {part}
      </code>
    ) : (
      part
    ),
  )
