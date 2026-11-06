import { Option, Schema } from "effect"

export const EnvironmentFilter = Schema.Struct({
  environmentIds: Schema.Array(Schema.NullOr(Schema.String)),
  hideOffline: Schema.Boolean,
})
export type EnvironmentFilter = typeof EnvironmentFilter.Type

export const allEnvironments: EnvironmentFilter = { environmentIds: [], hideOffline: false }

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(EnvironmentFilter))

export const parseEnvironmentFilter = (raw: string | null): EnvironmentFilter =>
  raw === null ? allEnvironments : Option.getOrElse(decode(raw), () => allEnvironments)

export interface FilterableEnvironment<Id extends string | null> {
  readonly id: Id
  readonly offline: boolean
}

export function shownEnvironmentIds<Id extends string | null>(
  filter: EnvironmentFilter,
  environments: ReadonlyArray<FilterableEnvironment<Id>>,
): ReadonlySet<Id> {
  if (environments.length < 2) return new Set(environments.map(({ id }) => id))
  const picked = environments.filter((environment) => filter.environmentIds.includes(environment.id))
  const candidates = picked.length === 0 ? environments : picked
  return new Set(candidates.filter((environment) => !(filter.hideOffline && environment.offline)).map(({ id }) => id))
}

export const pickedEnvironmentIds = <Id extends string | null>(
  filter: EnvironmentFilter,
  environments: ReadonlyArray<FilterableEnvironment<Id>>,
): ReadonlySet<Id> => new Set(environments.map(({ id }) => id).filter((id) => filter.environmentIds.includes(id)))

export const pickEnvironment = (
  filter: EnvironmentFilter,
  environmentId: string | null,
  picked: boolean,
): EnvironmentFilter => {
  const others = filter.environmentIds.filter((id) => id !== environmentId)
  return { ...filter, environmentIds: picked ? [...others, environmentId] : others }
}
