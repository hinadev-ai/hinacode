export const windowEntry = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("entry")
