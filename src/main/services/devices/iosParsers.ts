export const iosVersionOf = (runtime: string) =>
  /\.iOS-(\d+(?:-\d+)*)(?:-|$)/.exec(runtime)?.[1]?.replaceAll("-", ".") ?? null
