import { useState } from "react"
import { StyleSheet, TextInput, View } from "react-native"
import { Button } from "@/components/ui"
import { HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

interface RenameFormProps {
  readonly initial: string
  readonly label: string
  readonly testID: string
  readonly busy?: boolean
  readonly onSave: (name: string) => void
}

export function RenameForm({ initial, label, testID, busy = false, onSave }: RenameFormProps) {
  const theme = useTheme()
  const [name, setName] = useState(initial)
  return (
    <View style={styles.rename}>
      <TextInput
        testID={`${testID}-input`}
        accessibilityLabel={label}
        value={name}
        onChangeText={setName}
        onSubmitEditing={() => onSave(name)}
        autoFocus
        selectTextOnFocus
        returnKeyType="done"
        style={[styles.renameInput, { color: theme.text, backgroundColor: theme.card, borderColor: theme.border }]}
      />
      <Button
        testID={`${testID}-save`}
        label={copy("mobile_thread_rename_save")}
        variant="primary"
        busy={busy}
        disabled={name.trim() === ""}
        onPress={() => onSave(name)}
        style={styles.renameSave}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  rename: { gap: 12 },
  renameInput: {
    minHeight: HIT + 8,
    paddingHorizontal: 16,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
  renameSave: { borderRadius: radius.full },
})
