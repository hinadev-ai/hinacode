// Renders the desktop send button's feTurbulence grain (fractalNoise, baseFrequency 0.9, 3 octaves) to a PNG for React Native.
// Usage: node scripts/build-send-grain.mts [out.png] [size]
import { crc32, deflateSync } from "node:zlib"
import { writeFileSync } from "node:fs"

const [out = "assets/images/send-grain.png", sizeArg = "108"] = process.argv.slice(2)
const size = Number(sizeArg)
const p = new Uint8Array(512)
const perm = [...Array(256).keys()]
let s = 7
for (let i = 255; i > 0; i--) {
  s = (s * 16807) % 2147483647
  const j = s % (i + 1)
  const swap = perm[i] ?? 0
  perm[i] = perm[j] ?? 0
  perm[j] = swap
}
for (let i = 0; i < 512; i++) p[i] = perm[i & 255] ?? 0
const hash = (i: number) => p[i & 511] ?? 0
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
const lerp = (a: number, b: number, t: number) => a + t * (b - a)
const grad = (h: number, x: number, y: number) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y)
function perlin(x: number, y: number) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255
  x -= Math.floor(x); y -= Math.floor(y)
  const u = fade(x), v = fade(y)
  return lerp(
    lerp(grad(hash(hash(X) + Y), x, y), grad(hash(hash(X + 1) + Y), x - 1, y), u),
    lerp(grad(hash(hash(X) + Y + 1), x, y - 1), grad(hash(hash(X + 1) + Y + 1), x - 1, y - 1), u),
    v,
  )
}

// The PNG is drawn at 3x, so one CSS pixel spans three PNG pixels.
const freq = 0.9 / 3
const raw = Buffer.alloc(size * (size * 4 + 1))
for (let y = 0; y < size; y++) {
  raw[y * (size * 4 + 1)] = 0
  for (let x = 0; x < size; x++) {
    let n = 0, amp = 1, f = freq
    for (let o = 0; o < 3; o++) { n += amp * perlin(x * f, y * f); amp /= 2; f *= 2 }
    const r = Math.min(1, Math.max(0, (n + 1) / 2))
    const a = Math.min(1, Math.max(0, 1.6 * r - 0.35))
    const i = y * (size * 4 + 1) + 1 + x * 4
    // The filter's 0.5 gray is in linearRGB, which is 188 in sRGB. A true mid gray would vanish under overlay.
    raw[i] = raw[i + 1] = raw[i + 2] = 188
    raw[i + 3] = Math.round(a * 255)
  }
}

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, c])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
writeFileSync(out, Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
]))
