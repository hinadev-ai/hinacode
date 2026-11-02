import { AGENT_IMAGE_MAX_BYTES } from "@shared/agentImages.ts"
import { expect, it } from "vitest"
import { attachmentName, base64Bytes, fitImage } from "./attachable-image"

const head = (...bytes: ReadonlyArray<number | string>) =>
  Uint8Array.from(bytes.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : [part])))

const JPEG = head(0xff, 0xd8, 0xff, 0xe0)
const PNG = head(0x89, "PNG\r\n")
const WEBP = head("RIFF", 0, 0, 0, 0, "WEBP")
const HEIC = head(0, 0, 0, 0x18, "ftypheic")

it("sends an image the agent accepts as it is", () => {
  expect(fitImage(JPEG, AGENT_IMAGE_MAX_BYTES)).toEqual({ kind: "as-is", format: "jpeg" })
  expect(fitImage(PNG, 1783)).toEqual({ kind: "as-is", format: "png" })
  expect(fitImage(WEBP, 1024)).toEqual({ kind: "as-is", format: "webp" })
})

it("shrinks a photo over the agent's image limit", () => {
  expect(fitImage(JPEG, AGENT_IMAGE_MAX_BYTES + 1)).toEqual({ kind: "shrink", format: "jpeg" })
})

it("keeps a PNG a PNG when it shrinks it", () => {
  expect(fitImage(PNG, 12 * 1024 * 1024)).toEqual({ kind: "shrink", format: "png" })
})

it("converts a type the agent cannot read to JPEG", () => {
  expect(fitImage(HEIC, 1024)).toEqual({ kind: "shrink", format: "jpeg" })
})

it.each([
  ["small-logo.png", "png", "small-logo.png"],
  ["IMG_0001.heic", "jpeg", "IMG_0001.jpg"],
  ["20261022_201141.jpg", "jpeg", "20261022_201141.jpg"],
  ["18", "png", "image.png"],
  ["21.jpg", "jpeg", "image.jpg"],
  [null, "jpeg", "image.jpg"],
  [undefined, "gif", "image.gif"],
] as const)("names %j holding %s bytes %s", (fileName, format, name) => {
  expect(attachmentName(fileName, format)).toBe(name)
})

it.each([
  ["", 0],
  ["aGk=", 2],
  ["aGk/", 3],
  ["aA==", 1],
])("counts the bytes in %j", (base64, bytes) => {
  expect(base64Bytes(base64)).toBe(bytes)
})
