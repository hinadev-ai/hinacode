import { useState } from "react"
import { getRandomBytes } from "expo-crypto"
import { openAuthSessionAsync } from "expo-web-browser"
import { Image, Platform, StyleSheet, Text, TextInput, View } from "react-native"
import { Spinner } from "@/components/motion"
import { SettingsGroup, SettingsRow } from "@/components/settings-rows"
import { Button, Notice } from "@/components/ui"
import { mono, radius } from "@/constants/theme"
import { useNow } from "@/hooks/use-now"
import { useTheme } from "@/hooks/use-theme"
import { confirmAction } from "@/lib/confirm"
import { copy } from "@/lib/copy"
import { DEFAULT_RELAY_URL } from "@/lib/relay-account"
import { relativeTime } from "@/lib/relative-time"
import { useRelayAccount } from "@/stores/relay-account"

export function RelayAccountSection() {
  const serviceUrl = useRelayAccount((state) => state.serviceUrl)
  const unauthorized = useRelayAccount((state) => state.unauthorized)
  if (serviceUrl === null) {
    return (
      <SettingsGroup title={copy("mobile_relay_title")} footnote={copy("mobile_relay_footnote")}>
        <RelaySignIn initialUrl={DEFAULT_RELAY_URL} />
      </SettingsGroup>
    )
  }
  return (
    <>
      <RelayStatus serviceUrl={serviceUrl} />
      {unauthorized && (
        <SettingsGroup title={copy("mobile_relay_sign_in")}>
          <RelaySignIn initialUrl={serviceUrl} />
        </SettingsGroup>
      )}
    </>
  )
}

const hostOf = (url: string) => URL.parse(url)?.host ?? url

function RelayStatus({ serviceUrl }: { serviceUrl: string }) {
  const theme = useTheme()
  const now = useNow()
  const syncedAt = useRelayAccount((state) => state.syncedAt)
  const machines = useRelayAccount((state) => state.machines)
  const error = useRelayAccount((state) => state.error)
  const name = useRelayAccount((state) => state.name)
  const avatarUrl = useRelayAccount((state) => state.avatarUrl)
  const syncing = useRelayAccount((state) => state.syncing)
  const sync = useRelayAccount((state) => state.sync)
  const signOut = useRelayAccount((state) => state.signOut)
  return (
    <>
      {error !== null && <Notice tone="danger" text={error} />}
      <SettingsGroup title={copy("mobile_relay_title")} footnote={copy("mobile_relay_signed_in_footnote")}>
        {name !== null && (
          <SettingsRow label={name}>
            {avatarUrl !== null && <Image source={{ uri: avatarUrl }} accessibilityIgnoresInvertColors style={styles.avatar} />}
          </SettingsRow>
        )}
        <SettingsRow icon="Plug" label={copy("mobile_relay_service")} value={hostOf(serviceUrl)} />
        <SettingsRow
          icon="Computer"
          label={copy("mobile_relay_machines")}
          value={machines === null ? undefined : String(machines)}
        />
        <SettingsRow
          icon="Clock"
          label={copy("mobile_relay_last_sync")}
          value={syncedAt === null ? copy("mobile_relay_never") : relativeTime(syncedAt, now)}
        />
        <SettingsRow
          icon="Refresh"
          label={copy("mobile_relay_sync_now")}
          disabled={syncing}
          onPress={() => void sync()}
        >
          {syncing && <Spinner color={theme.textMuted} />}
        </SettingsRow>
        <SettingsRow
          icon="RiLogoutBoxRLine"
          label={copy("mobile_relay_sign_out")}
          onPress={() =>
            confirmAction(
              copy("mobile_relay_sign_out_title"),
              copy("mobile_relay_sign_out_message"),
              copy("mobile_relay_sign_out"),
              () => void signOut(),
              { destructive: true },
            )
          }
        />
      </SettingsGroup>
    </>
  )
}

const deviceName = Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "Android" : "Phone"

const authenticate = async (url: string, redirectUri: string) => {
  const result = await openAuthSessionAsync(url, redirectUri)
  return result.type === "success" ? result.url : null
}

function RelaySignIn({ initialUrl }: { initialUrl: string }) {
  const theme = useTheme()
  const signIn = useRelayAccount((state) => state.signIn)
  const [serviceUrl, setServiceUrl] = useState(initialUrl)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (serviceUrl.trim() === "") {
      setError(copy("mobile_relay_service_required"))
      return
    }
    setBusy(true)
    setError(null)
    await signIn({ serviceUrl: serviceUrl.trim(), deviceName, random: getRandomBytes(32), authenticate })
      .then(setError)
      .finally(() => setBusy(false))
  }
  const inputStyle = [styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]
  return (
    <View style={styles.permission}>
      <Text style={[styles.fieldLabel, { color: theme.text }]}>{copy("mobile_relay_service_url")}</Text>
      <TextInput
        accessibilityLabel={copy("mobile_relay_service_url")}
        value={serviceUrl}
        onChangeText={setServiceUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={inputStyle}
      />
      {error !== null && <Notice tone="danger" text={error} />}
      <Button
        icon="ShieldKeyhole"
        variant="primary"
        label={copy("mobile_relay_sign_in")}
        busy={busy}
        onPress={() => void submit()}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  permission: { gap: 8, padding: 12 },
  avatar: { width: 28, height: 28, borderRadius: 14 },
  fieldLabel: { fontSize: 14, fontWeight: "600" },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    fontFamily: mono,
    fontSize: 14,
  },
})
