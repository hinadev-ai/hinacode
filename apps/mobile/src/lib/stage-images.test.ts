import { REMOTE_MAX_FRAME_BYTES } from "@shared/remote.ts"
import type { ImagePickerAsset } from "expo-image-picker"
import { beforeEach, expect, it, vi } from "vitest"
import { flush, type PendingCall } from "@/stores/testing"

const calls = vi.hoisted((): PendingCall[] => [])
vi.mock("@/lib/connection", async () => ({ call: (await import("@/stores/testing")).fakeCall(calls) }))
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: vi.fn() }))

const { stageImage } = await import("./stage-images")

const asset = (base64: string): ImagePickerAsset => ({
  uri: "file:///photo.png",
  width: 1,
  height: 1,
  base64,
  mimeType: "image/png",
  fileName: "photo.png",
})

beforeEach(() => {
  calls.length = 0
})

it("stages a picked image as a data URL", async () => {
  const staging = stageImage("t1", asset("aGk="))
  await flush()

  expect(calls).toHaveLength(1)
  expect(calls[0]!.method).toBe("attachments.stage")
  expect(calls[0]!.payload).toEqual({
    threadId: "t1",
    source: { dataUrl: "data:image/png;base64,aGk=", name: "photo.png" },
  })
  calls[0]!.resolve({ id: "a", name: "photo.png", path: "/staged/a.png", mime: "image/png", kind: "image", bytes: 2 })
  await expect(staging).resolves.toMatchObject({ preview: "file:///photo.png", attachment: { id: "a" } })
})

const JPEG = "/9j/4AAQSkZJRgABAQ=="

it.each([
  ["image/heic", "IMG_0001.heic", "IMG_0001.jpg"],
  ["image/png", "photo.png", "photo.jpg"],
  [undefined, null, "image.jpg"],
])("labels JPEG bytes as JPEG when the picker declared %s", async (mimeType, fileName, name) => {
  void stageImage("t1", { ...asset(JPEG), mimeType, fileName })
  await flush()

  expect(calls[0]!.payload).toEqual({ threadId: "t1", source: { dataUrl: `data:image/jpeg;base64,${JPEG}`, name } })
})

it("keeps the declared type of bytes it does not recognize", async () => {
  void stageImage("t1", { ...asset("AAECAwQFBgcICQoL"), mimeType: "image/heic", fileName: "IMG_0001.heic" })
  await flush()

  expect(calls[0]!.payload).toEqual({
    threadId: "t1",
    source: { dataUrl: "data:image/heic;base64,AAECAwQFBgcICQoL", name: "IMG_0001.heic" },
  })
})

it("refuses an image too large for one socket frame without sending it", async () => {
  await expect(stageImage("t1", asset("A".repeat(REMOTE_MAX_FRAME_BYTES)))).rejects.toThrow("photo.png is too large")
  expect(calls).toHaveLength(0)
})
