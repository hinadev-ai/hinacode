import { animate, type AnimationPlaybackControls, motionValue } from "motion"
import * as THREE from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js"
import { type ColorScheme, type DeviceSpec, fitScale, type FrameLayout, type Size } from "./geometry.ts"

export interface SceneInput {
  readonly spec: DeviceSpec
  readonly layout: FrameLayout
  readonly scheme: ColorScheme
  readonly viewport: Size & { readonly dpr: number }
}

/** How far the DOM screen is from its laid-out rect on this frame, so it can follow the glass. */
export interface ScreenOffset {
  /** CSS rotation in radians, clockwise. */
  readonly rotate: number
  readonly scale: number
  readonly lift: number
  /** 0 hides the screen while the device is still tilted, 1 shows it. */
  readonly reveal: number
}

export interface DeviceScene {
  readonly update: (input: SceneInput) => void
  readonly dispose: () => void
}

const FOV = 15
const TURN = { type: "spring", visualDuration: 0.55, bounce: 0.12 } as const
const SETTLE = { type: "spring", visualDuration: 0.5, bounce: 0.18 } as const
const SETTLE_TILT = 0.5
const SETTLE_LIFT = 28

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * Draws the device body behind the DOM screen and renders only when something changes.
 * Returns null when WebGL is unavailable. `onLost` fires if the context is lost later.
 */
export function createDeviceScene(
  canvas: HTMLCanvasElement,
  onFrame: (offset: ScreenOffset) => void,
  onLost: () => void,
): DeviceScene | null {
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  } catch {
    return null
  }
  renderer.toneMapping = THREE.NeutralToneMapping
  canvas.addEventListener("webglcontextlost", onLost)

  const pmrem = new THREE.PMREMGenerator(renderer)
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  const scene = new THREE.Scene()
  scene.environment = environment
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 10)
  const key = new THREE.DirectionalLight(0xffffff, 1.2)
  key.position.set(-0.4, 0.8, 1)
  const rim = new THREE.DirectionalLight(0xffffff, 0)
  rim.position.set(0.3, 1, -0.6)
  scene.add(key, rim)

  const metal = new THREE.MeshPhysicalMaterial()
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x050506,
    roughness: 0.06,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
  })
  const lens = new THREE.MeshPhysicalMaterial({ color: 0x0b0d14, roughness: 0.1, clearcoat: 1 })
  const device = new THREE.Group()
  scene.add(device)

  const angle = motionValue(0)
  const settle = motionValue(0)
  const animations = new Map<typeof angle, AnimationPlaybackControls>()
  let current: SceneInput | null = null
  let frameRequest = 0

  const draw = () => {
    frameRequest = 0
    if (!current) return
    const { spec, layout, viewport } = current
    const lift = settle.get() * SETTLE_LIFT
    // Scaled to fit at every angle of a turn. The ratio keeps the rest pose on the snapped layout scale.
    const scale = layout.scale * (fitScale(spec, viewport, angle.get()) / fitScale(spec, viewport, layout.angle) || 1)
    device.rotation.set(settle.get() * SETTLE_TILT, 0, angle.get())
    device.scale.setScalar(scale)
    device.position.set(
      layout.screen.x + layout.screen.width / 2 - viewport.width / 2,
      viewport.height / 2 - (layout.screen.y + layout.screen.height / 2) - lift,
      0,
    )
    renderer.render(scene, camera)
    onFrame({
      rotate: layout.angle - angle.get(),
      scale: layout.scale === 0 ? 1 : scale / layout.scale,
      lift,
      reveal: Math.min(1, Math.max(0, 1 - settle.get() / 0.3)),
    })
  }
  const invalidate = () => {
    if (!frameRequest) frameRequest = requestAnimationFrame(draw)
  }
  const unsubscribe = [angle, settle].map((value) => value.on("change", invalidate))

  const to = (value: typeof angle, target: number, transition: typeof TURN | typeof SETTLE | null) => {
    animations.get(value)?.stop()
    animations.delete(value)
    if (transition) animations.set(value, animate(value, target, transition))
    else value.jump(target)
  }

  const update = (input: SceneInput) => {
    const previous = current
    current = input
    if (!previous || !sameShape(previous.spec, input.spec)) rebuild(input.spec)
    if (previous?.scheme !== input.scheme || previous.spec.model !== input.spec.model) applyScheme(input)
    const { width, height, dpr } = input.viewport
    if (previous?.viewport.width !== width || previous.viewport.height !== height || previous.viewport.dpr !== dpr) {
      renderer.setPixelRatio(dpr)
      renderer.setSize(width, height, false)
      const distance = height / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2))
      camera.aspect = width / Math.max(height, 1)
      camera.position.set(0, 0, distance)
      camera.near = distance / 4
      camera.far = distance * 4
      camera.updateProjectionMatrix()
    }

    const instant = reducedMotion()
    if (!previous) {
      angle.jump(input.layout.angle)
      settle.jump(instant ? 0 : 1)
      to(settle, 0, instant ? null : SETTLE)
      draw()
      return
    }
    if (previous.layout.angle !== input.layout.angle) to(angle, input.layout.angle, instant ? null : TURN)
    invalidate()
  }

  const rebuild = (spec: DeviceSpec) => {
    for (const mesh of device.children) if (mesh instanceof THREE.Mesh) mesh.geometry.dispose()
    device.clear()
    device.add(new THREE.Mesh(bodyGeometry(spec), [glass, metal]))
    for (const button of spec.buttons) {
      const along = button.side === "top"
      const mesh = new THREE.Mesh(
        new RoundedBoxGeometry(along ? button.length : 3, along ? 3 : button.length, spec.depth * 0.3, 2, 1),
        metal,
      )
      const { width, height } = spec.body
      const out = 0.6
      mesh.position.set(
        along ? -width / 2 + button.offset + button.length / 2 : (button.side === "left" ? -1 : 1) * (width / 2 + out),
        along ? height / 2 + out : height / 2 - button.offset - button.length / 2,
        -spec.depth / 2,
      )
      device.add(mesh)
    }
    if (spec.bezelCamera) {
      const frontCamera = new THREE.Mesh(new THREE.CircleGeometry(spec.bezelCamera / 2, 24), lens)
      frontCamera.position.set(0, spec.screen.height / 2 + spec.bezel / 2, 0.1)
      device.add(frontCamera)
    }
  }

  const applyScheme = ({ spec, scheme }: SceneInput) => {
    const finish = spec.finish[scheme]
    metal.color.setHex(finish.color)
    metal.metalness = finish.metalness
    metal.roughness = finish.roughness
    scene.environmentIntensity = scheme === "dark" ? 0.75 : 1
    rim.intensity = scheme === "dark" ? 2.4 : 0
  }

  return {
    update,
    dispose: () => {
      for (const animation of animations.values()) animation.stop()
      for (const stop of unsubscribe) stop()
      cancelAnimationFrame(frameRequest)
      canvas.removeEventListener("webglcontextlost", onLost)
      for (const mesh of device.children) if (mesh instanceof THREE.Mesh) mesh.geometry.dispose()
      for (const material of [metal, glass, lens]) material.dispose()
      environment.dispose()
      pmrem.dispose()
      renderer.dispose()
    },
  }
}

const sameShape = (a: DeviceSpec, b: DeviceSpec) =>
  a.model === b.model && a.screen.width === b.screen.width && a.screen.height === b.screen.height

/** The body as one rounded slab, with the glass at z = 0. Group 0 is the glass faces, group 1 the metal frame. */
function bodyGeometry({ body, bodyRadius, depth, edge }: DeviceSpec) {
  const width = body.width - edge * 2
  const height = body.height - edge * 2
  const radius = Math.max(bodyRadius - edge, 0.1)
  const shape = new THREE.Shape()
  const x = -width / 2
  const y = -height / 2
  shape.moveTo(x + radius, y)
  shape.lineTo(x + width - radius, y)
  shape.quadraticCurveTo(x + width, y, x + width, y + radius)
  shape.lineTo(x + width, y + height - radius)
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  shape.lineTo(x + radius, y + height)
  shape.quadraticCurveTo(x, y + height, x, y + height - radius)
  shape.lineTo(x, y + radius)
  shape.quadraticCurveTo(x, y, x + radius, y)
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: depth - edge * 2,
    bevelEnabled: true,
    bevelThickness: edge,
    bevelSize: edge,
    bevelSegments: 8,
    curveSegments: 32,
  })
  geometry.translate(0, 0, edge - depth)
  return geometry
}
