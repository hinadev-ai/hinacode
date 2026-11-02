export function lineCounts(patch: string) {
  let added = 0
  let removed = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) added++
    else if (line.startsWith("-") && !line.startsWith("--- ")) removed++
  }
  return { added, removed }
}
