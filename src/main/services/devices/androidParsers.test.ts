import { expect, test } from "vitest"
import { androidVersionOf, parseDiscoveryFile, parseUiHierarchy } from "./androidParsers.ts"

const DISCOVERY = `emulator.build=16428233
avd.id=hinacode-verify-android-1
emulator.version=37.2.12.0
port.serial=5584
port.adb=5585
avd.name=hinacode-verify-android-1
avd.dir=/Users/me/.android/avd/hinacode-verify-android-1.avd
grpc.port=8574
grpc.token=c2VjcmV0
`

test("reads an emulator's serial, gRPC port and token from its discovery file", () => {
  expect(parseDiscoveryFile("pid_30515.ini", DISCOVERY)).toEqual({
    pid: 30515,
    avdName: "hinacode-verify-android-1",
    serialPort: 5584,
    grpcPort: 8574,
    grpcToken: "c2VjcmV0",
  })
})

test("names the emulator by its AVD id, not the display name Android Studio gives it", () => {
  const renamed = DISCOVERY.replace("avd.name=hinacode-verify-android-1", "avd.name=Pixel 10 Pro (2)")
  expect(parseDiscoveryFile("pid_7.ini", renamed)?.avdName).toBe("hinacode-verify-android-1")
})

test("reads an emulator started without gRPC as one with no endpoint", () => {
  const withoutGrpc = DISCOVERY.replace(/^grpc\..*$/gm, "")
  expect(parseDiscoveryFile("pid_7.ini", withoutGrpc)).toMatchObject({ grpcPort: null, grpcToken: null })
})

test("ignores files that do not describe an emulator", () => {
  expect(parseDiscoveryFile("pid_7.ini", "port.serial=5554\n")).toBeNull()
  expect(parseDiscoveryFile("notes.ini", DISCOVERY)).toBeNull()
})

test.each([
  ["system-images/android-36/google_apis/arm64-v8a/", "Android 16"],
  ["system-images/android-32/default/x86_64/", "Android 12L"],
  ["system-images/android-40/google_apis/arm64-v8a/", "API 40"],
  ["system-images/android-Baklava/google_apis/arm64-v8a/", "Android Baklava"],
  [undefined, "Android"],
])("names the system image %s as %s", (dir, version) => expect(androidVersionOf(dir)).toBe(version))

const HIERARCHY = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" clickable="false" scrollable="false" bounds="[0,0][1080,2400]">
<node index="0" text="Search &amp; find &quot;apps&quot;" resource-id="com.android.settings:id/search_action_bar_title" class="android.widget.TextView" content-desc="" clickable="false" scrollable="false" bounds="[147,180][933,300]" />
<node index="1" text="" resource-id="" class="android.widget.ImageButton" content-desc="Navigate up" clickable="true" scrollable="false" bounds="[0,105][147,252]" />
<node index="2" text="hello" resource-id="com.example:id/name" class="android.widget.EditText" content-desc="Name" clickable="true" scrollable="false" bounds="[42,420][1038,567]" />
<node index="3" text="" resource-id="" class="androidx.recyclerview.widget.RecyclerView" content-desc="" clickable="false" scrollable="true" bounds="[0,600][1080,2400]" />
</node></hierarchy>UI hierchary dumped to: /dev/tty`

test("flattens a uiautomator dump into named or actionable elements with frames in points", () => {
  expect(parseUiHierarchy(HIERARCHY, 2.625)).toEqual([
    {
      role: "TextView",
      label: 'Search & find "apps"',
      identifier: "com.android.settings:id/search_action_bar_title",
      value: "",
      frame: { x: 56, y: 68.57142857142857, width: 299.42857142857144, height: 45.714285714285715 },
    },
    {
      role: "ImageButton",
      label: "Navigate up",
      identifier: "",
      value: "",
      frame: { x: 0, y: 40, width: 56, height: 56 },
    },
    {
      role: "EditText",
      label: "hello",
      identifier: "com.example:id/name",
      value: "hello",
      frame: { x: 16, y: 160, width: 379.42857142857144, height: 56 },
    },
    {
      role: "RecyclerView",
      label: "",
      identifier: "",
      value: "",
      frame: { x: 0, y: 228.57142857142858, width: 411.42857142857144, height: 685.7142857142857 },
    },
  ])
})
