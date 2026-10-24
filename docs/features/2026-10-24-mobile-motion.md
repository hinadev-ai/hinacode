# Mobile motion

Status: Shipped
Date: 2026-10-24

## Problem

On the phone, the changes a developer waits for happen without motion. A sent prompt or the agent's reply pops into the transcript, an approval card vanishes the moment it is answered, and the send button turns into Stop with no transition, so it is easy to miss that the turn started. The motion that does exist is eight hand-written helpers, each one wiring Reanimated by hand and checking reduce motion its own way. `motion/react` would give the app one vocabulary, but it renders to the DOM and cannot run in React Native.

## User flow

1. The developer sends a prompt. Their message rises 4 px into the transcript as it fades in, and so does the agent's reply when it starts. Messages already there when the thread opened stay still.
2. The agent starts. The send button's color shifts to Stop's and the arrow cross-fades into the stop square. Typing a steer turns it back.
3. An approval or a question rises in above the composer. Once answered, it fades out, and any card still waiting slides into its place.
4. The connection drops. The thread's reconnecting notice fades in.
5. With Reduce Motion on, every fade and color change stays, and nothing moves.

## Design

`apps/mobile/src/lib/motion.tsx` is a small take on `motion/react`'s `motion` components, run by Reanimated 4 on the UI thread. `motion.View` and `motion.Pressable` take:

| Prop         | Meaning, as in Motion                                   | Reanimated                                              |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------- |
| `initial`    | Values on mount, or `false` to start at `animate`       | Initial value of one shared value per key               |
| `animate`    | Values to animate to whenever they change               | `withTiming` or `withSpring`, set from an effect        |
| `exit`       | Values to animate to on unmount, no `AnimatePresence`   | A custom `exiting` layout animation from current values |
| `transition` | One transition, with per-value overrides by key         | Picked like Motion's `getValueTransition`               |
| `whileTap`   | Values while a finger is down (`motion.Pressable` only) | Set on `onPressIn`, back to `animate` on `onPressOut`   |
| `layout`     | Slide to a new place when layout changes                | `LinearTransition` with `duration.base` and `ease.out`  |

- Values are `opacity`, `y`, `scale`, `rotate` (degrees) and `backgroundColor`. Only the values a caller names reach the style, so the `style` prop keeps the rest.
- A transition is a tween (`duration`, `ease`, `delay`), defaulting to `duration.base` and `ease.out` from `constants/motion.ts`, or a spring with `visualDuration`, using Motion's formula for stiffness and damping with no bounce. Times are in milliseconds, like the rest of the app. A target may carry its own `transition`, as the banner's faster exit does.
- Reduce motion follows Motion's `reducedMotion="user"`: `y`, `scale` and `rotate` jump to their `animate` value, so `initial`, `exit`, `whileTap` and `layout` move nothing, while opacity and color still animate.
- Press feedback is a spring (`pressSpring`), so a tap that lifts mid-shrink turns back without a jolt.
- `PressableScale`, `Reveal`, `FadeIn`, `RiseIn`, `IconSwap` and `Rotate` in `components/motion.tsx` keep their names and props and are built on it. `Spinner` and `StatusDot` loop forever, which the API does not do, so they stay CSS animations.

Where it is used: the transcript's new messages, approval and question cards, the composer's send and stop button, the banner and `Notice`.

Where it is not:

- Sheets already rise over a fading scrim, and the `Modal` fades them out. Porting them would not delete code.
- Tab switches are frequent, and the segmented control's thumb already slides. Fading the panel would only delay the content.
- The connection badge. The home header remounts it on every retry, so a fade there would flash on each attempt while offline.
- Streaming text. Animating each chunk would cost frames on the busiest path and draw the eye to every token.

## Out of scope

- Variants, `AnimatePresence`, keyframe arrays, repeat, drag and gestures beyond a tap. No screen needs them yet.
- Motion values (`useMotionValue`, `useTransform`). Reanimated's shared values already are that.

## Verification

- On the iOS simulator, paired with an isolated desktop running a mock agent: record sending a prompt, a streamed reply, an approval appearing and resolving, the send button turning into Stop, a banner and the connection dropping. Record again with Reduce Motion on.
- The perf monitor holds 60 fps on the UI and JS threads while a reply streams.
- `npx tsc --noEmit` and `npx expo lint` in `apps/mobile`.
