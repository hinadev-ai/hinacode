import type { LegendListRef } from "@legendapp/list/react"
import { type RefObject, useEffect, useRef, useState } from "react"
import type { Message } from "../../shared/domain.ts"

const ANCHOR_OFFSET = 24
const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"])

export function useFollowLatest(listRef: RefObject<LegendListRef | null>, messages: ReadonlyArray<Message>) {
  const anchorIndex = messages.findLastIndex((message) => message.role === "user")
  const anchorId = messages[anchorIndex]?.id
  const [following, setFollowing] = useState(true)
  const [atEnd, setAtEnd] = useState(true)
  const [followedAnchor, setFollowedAnchor] = useState(anchorId)
  if (anchorId !== followedAnchor) {
    setFollowedAnchor(anchorId)
    setFollowing(true)
  }
  const scrolledAnchor = useRef<string | undefined>(undefined)
  const lastScroll = useRef(0)

  useEffect(() => {
    const node = listRef.current?.getScrollableNode()
    if (!node) return
    const stop = () => setFollowing(false)
    const onWheel = (event: WheelEvent) => event.deltaY < 0 && stop()
    const onKey = (event: KeyboardEvent) =>
      (SCROLL_UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) && stop()
    const onPointer = (event: PointerEvent) => event.target === node && stop()
    node.addEventListener("wheel", onWheel, { passive: true })
    node.addEventListener("touchmove", stop, { passive: true })
    node.addEventListener("keydown", onKey)
    node.addEventListener("pointerdown", onPointer)
    return () => {
      node.removeEventListener("wheel", onWheel)
      node.removeEventListener("touchmove", stop)
      node.removeEventListener("keydown", onKey)
      node.removeEventListener("pointerdown", onPointer)
    }
  }, [listRef])

  const onScroll = () => {
    const state = listRef.current?.getState()
    if (!state) return
    const movedDown = state.scroll > lastScroll.current
    lastScroll.current = state.scroll
    setAtEnd(state.isAtEnd)
    if (state.isAtEnd && movedDown) setFollowing(true)
  }

  const onAnchorReady = ({ anchorKey }: { anchorKey: string | undefined }) => {
    const previous = scrolledAnchor.current
    if (anchorKey === undefined || anchorKey === previous) return
    scrolledAnchor.current = anchorKey
    const sameConversation = messages.some((message) => message.id === previous)
    if (sameConversation) void listRef.current?.scrollToEnd({ animated: true })
  }

  const jumpToLatest = () => {
    setFollowing(true)
    void listRef.current?.scrollToEnd({ animated: true })
  }

  const listProps = {
    maintainScrollAtEnd: following ? { animated: true } : false,
    anchoredEndSpace:
      anchorIndex < 0 ? undefined : { anchorIndex, anchorOffset: ANCHOR_OFFSET, onReady: onAnchorReady },
    onScroll,
  }
  return { listProps, anchored: anchorIndex >= 0, atEnd, jumpToLatest }
}
