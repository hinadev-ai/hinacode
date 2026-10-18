import { router } from "expo-router"

export const openThread = (id: string) => router.push({ pathname: "/thread/[id]", params: { id } })
