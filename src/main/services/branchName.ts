export const slugifyBranch = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .split("/")
    .map((segment) => segment.replace(/^[-.]+|[-.]+$/g, "").replace(/\.lock$/, ""))
    .filter((segment) => segment !== "")
    .join("/")
    .slice(0, 80)
