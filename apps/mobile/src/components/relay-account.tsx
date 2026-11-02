import { useState } from "react"
import { StyleSheet, Text, TextInput, View } from "react-native"
import { Spinner } from "@/components/motion"
import { SettingsGroup, SettingsRow } from "@/components/settings-rows"
import { Button, Notice } from "@/components/ui"
import { mono, radius } from "@/constants/theme"
import { useNow } from "@/hooks/use-now"
import { useTheme } from "@/hooks/use-theme"
import { confirmDestructive } from "@/lib/confirm"
import { copy } from "@/lib/copy"
import { DEFAULT_RELAY_URL } from "@/lib/relay-account"
import { relativeTime } from "@/lib/relative-time"
import { useRelayAccount } from "@/stores/relay-account"

/** Signs in to the relay with the owner token, so every machine shown on the relay page appears here. */
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
  const syncing = useRelayAccount((state) => state.syncing)
  const sync = useRelayAccount((state) => state.sync)
  const signOut = useRelayAccount((state) => state.signOut)
  return (
    <>
      {error !== null && <Notice tone="danger" text={error} />}
      <SettingsGroup title={copy("mobile_relay_title")} footnote={copy("mobile_relay_signed_in_footnote")}>
        <SettingsRow icon="RiPlugLine" label={copy("mobile_relay_service")} value={hostOf(serviceUrl)} />
        <SettingsRow
          icon="RiComputerLine"
          label={copy("mobile_relay_machines")}
          value={machines === null ? undefined : String(machines)}
        />
        <SettingsRow
          icon="RiTimeLine"
          label={copy("mobile_relay_last_sync")}
          value={syncedAt === null ? copy("mobile_relay_never") : relativeTime(syncedAt, now)}
        />
        <SettingsRow
          icon="RiRefreshLine"
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
            confirmDestructive(
              copy("mobile_relay_sign_out_title"),
              copy("mobile_relay_sign_out_message"),
              copy("mobile_relay_sign_out"),
              () => void signOut(),
            )
          }
        />
      </SettingsGroup>
    </>
  )
}

/** Saves the account only once the relay accepts the owner token. */
function RelaySignIn({ initialUrl }: { initialUrl: string }) {
  const theme = useTheme()
  const signIn = useRelayAccount((state) => state.signIn)
  const [serviceUrl, setServiceUrl] = useState(initialUrl)
  const [ownerToken, setOwnerToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (serviceUrl.trim() === "" || ownerToken.trim() === "") {
      setError(copy("mobile_relay_fields_required"))
      return
    }
    setBusy(true)
    setError(null)
    try {
      setError(await signIn({ serviceUrl: serviceUrl.trim(), ownerToken: ownerToken.trim() }))
    } finally {
      setBusy(false)
    }
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
      <Text style={[styles.fieldLabel, { color: theme.text }]}>{copy("mobile_relay_owner_token")}</Text>
      <TextInput
        accessibilityLabel={copy("mobile_relay_owner_token")}
        value={ownerToken}
        onChangeText={setOwnerToken}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={inputStyle}
      />
      {error !== null && <Notice tone="danger" text={error} />}
      <Button
        icon="RiShieldKeyholeLine"
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
