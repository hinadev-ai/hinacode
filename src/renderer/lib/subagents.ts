import { useNavigate } from "@tanstack/react-router"

export function useOpenSubagent(threadId: string) {
  const navigate = useNavigate()
  return (callId: string | undefined) =>
    void navigate({
      to: "/thread/$threadId",
      params: { threadId },
      search: callId === undefined ? {} : { agent: callId },
    })
}
