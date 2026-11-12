import { useEvent, useEventListener } from "expo"
import { useVideoPlayer, VideoView } from "expo-video"
import { startTransition, useEffect, useState } from "react"
import { Pressable, StyleSheet, View } from "react-native"
import Animated, { useReducedMotion } from "react-native-reanimated"
import Svg, { Circle, Path, Rect } from "react-native-svg"
import { EmptyState } from "@/components/ui"
import { cssEase, duration } from "@/constants/motion"
import { copy } from "@/lib/copy"

const CONTROL_SIZE = 88
const RING_WIDTH = 3
const RING_RADIUS = (CONTROL_SIZE - RING_WIDTH) / 2
const RING_LENGTH = 2 * Math.PI * RING_RADIUS
const HIDE_CONTROL_AFTER_MS = 1500

export function VideoPlayer({ uri, label }: { uri: string; label: string }) {
  const player = useVideoPlayer(uri, (created) => {
    created.loop = true
    created.timeUpdateEventInterval = 0.1
    created.play()
  })
  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing })
  const { status } = useEvent(player, "statusChange", { status: player.status })
  const [progress, setProgress] = useState(0)
  const [controlShown, setControlShown] = useState(true)
  useEventListener(player, "timeUpdate", ({ currentTime }) =>
    setProgress(player.duration > 0 ? currentTime / player.duration : 0),
  )

  useEffect(() => {
    if (!isPlaying || !controlShown) return
    const timer = setTimeout(() => setControlShown(false), HIDE_CONTROL_AFTER_MS)
    return () => clearTimeout(timer)
  }, [isPlaying, controlShown])

  if (status === "error") return <EmptyState icon="FileVideo" title={copy("mobile_files_video_failed")} />

  const toggle = () => {
    if (isPlaying) player.pause()
    else player.play()
    startTransition(() => setControlShown(true))
  }
  const reveal = () => startTransition(() => setControlShown(true))

  return (
    <View style={styles.stage}>
      <VideoView
        player={player}
        nativeControls={false}
        contentFit="contain"
        accessibilityLabel={label}
        style={StyleSheet.absoluteFill}
      />
      <Pressable
        accessible={false}
        importantForAccessibility="no"
        onPress={controlShown ? toggle : reveal}
        style={styles.surface}
      >
        <PlaybackControl playing={isPlaying} progress={progress} shown={controlShown || !isPlaying} onPress={toggle} />
      </Pressable>
    </View>
  )
}

function PlaybackControl({
  playing,
  progress,
  shown,
  onPress,
}: {
  playing: boolean
  progress: number
  shown: boolean
  onPress: () => void
}) {
  const reduced = useReducedMotion()
  return (
    <Animated.View
      style={[
        styles.control,
        { opacity: shown ? 1 : 0, pointerEvents: shown ? "auto" : "none" },
        !reduced && {
          transitionProperty: "opacity",
          transitionDuration: duration.base,
          transitionTimingFunction: cssEase.out,
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy(playing ? "mobile_files_video_pause" : "mobile_files_video_play")}
        onPress={onPress}
        hitSlop={8}
      >
        <Svg width={CONTROL_SIZE} height={CONTROL_SIZE} viewBox={`0 0 ${CONTROL_SIZE} ${CONTROL_SIZE}`}>
          <Circle cx={CONTROL_SIZE / 2} cy={CONTROL_SIZE / 2} r={RING_RADIUS} fill="rgba(0, 0, 0, 0.32)" />
          <Circle
            cx={CONTROL_SIZE / 2}
            cy={CONTROL_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="rgba(255, 255, 255, 0.45)"
            strokeWidth={RING_WIDTH}
          />
          <Circle
            cx={CONTROL_SIZE / 2}
            cy={CONTROL_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="#fff"
            strokeWidth={RING_WIDTH}
            strokeLinecap="round"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - progress)}
            transform={`rotate(-90 ${CONTROL_SIZE / 2} ${CONTROL_SIZE / 2})`}
          />
          {playing ? (
            <>
              <Rect x={34} y={30} width={7} height={28} rx={2.5} fill="#fff" />
              <Rect x={47} y={30} width={7} height={28} rx={2.5} fill="#fff" />
            </>
          ) : (
            <Path d="M37 30.5 L59 44 L37 57.5 Z" fill="#fff" stroke="#fff" strokeWidth={4} strokeLinejoin="round" />
          )}
        </Svg>
      </Pressable>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: "#000" },
  surface: { flex: 1, alignItems: "center", justifyContent: "center" },
  control: { borderRadius: CONTROL_SIZE / 2 },
})
