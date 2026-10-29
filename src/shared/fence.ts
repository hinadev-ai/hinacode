export const fenceFor = (text: string) =>
  "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(([run]) => run.length + 1)))
