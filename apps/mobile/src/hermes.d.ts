// FIXME: Hermes has findLast and findLastIndex but no other ES2023 array method, so tsconfig pins lib to ES2022 and declares these two.
interface ReadonlyArray<T> {
  findLast<S extends T>(predicate: (value: T, index: number, array: readonly T[]) => value is S): S | undefined
  findLast(predicate: (value: T, index: number, array: readonly T[]) => unknown): T | undefined
  findLastIndex(predicate: (value: T, index: number, array: readonly T[]) => unknown): number
}
interface Array<T> {
  findLast<S extends T>(predicate: (value: T, index: number, array: T[]) => value is S): S | undefined
  findLast(predicate: (value: T, index: number, array: T[]) => unknown): T | undefined
  findLastIndex(predicate: (value: T, index: number, array: T[]) => unknown): number
}
