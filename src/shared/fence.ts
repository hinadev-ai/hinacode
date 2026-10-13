/** A Markdown code fence longer than any backtick run in `text`, so the text cannot close it. */
export const fenceFor = (text: string) =>
  "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(([run]) => run.length + 1)))
