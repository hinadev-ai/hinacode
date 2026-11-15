export const iosVersionOf = (runtime: string) => /\.iOS-([\d-]+)$/.exec(runtime)?.[1]?.replaceAll("-", ".") ?? null
