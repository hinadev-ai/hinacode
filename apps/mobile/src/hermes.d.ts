// Hermes has findLast and findLastIndex but none of the other ES2023 array methods, so tsconfig
// pins lib to ES2022 and declares the two it does have here.
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
