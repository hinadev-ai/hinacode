import type { Project } from "@shared/domain.ts"
import { parseGitHubRepository } from "@shared/github.ts"
import { router } from "expo-router"
import { useHeaderHeight } from "expo-router/react-navigation"
import { useState } from "react"
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, type TextInputProps, View } from "react-native"
import { Icon } from "@/components/icon"
import { Button, Notice } from "@/components/ui"
import { mono, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { baseName, defaultCloneFolder } from "@/lib/projects"
import { useThreads } from "@/stores/threads"

export default function AddProjectScreen() {
  const theme = useTheme()
  // KeyboardAvoidingView measures itself against its parent, which starts below the stack header.
  const headerHeight = useHeaderHeight()
  const projects = useThreads((state) => state.projects)
  const [source, setSource] = useState("")
  const [cloneTo, setCloneTo] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A project the desktop added before its first thread failed, so trying again only retries the thread.
  const [added, setAdded] = useState<Project | null>(null)

  const repository = parseGitHubRepository(source)
  const cloneFolder = repository === null ? "" : (cloneTo ?? defaultCloneFolder(projects, repository.name))
  const namePlaceholder = repository?.name ?? (baseName(source) || copy("mobile_project_name_placeholder"))
  const ready = repository === null ? source.trim() !== "" : cloneFolder.trim() !== ""

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const project =
        added ??
        (repository === null
          ? await call("projects.create", {
              name: name.trim() || baseName(source),
              rootPath: source.trim(),
              setupScript: null,
            })
          : await call("projects.clone", {
              repository,
              rootPath: cloneFolder.trim(),
              name: name.trim() || repository.name,
              setupScript: null,
            }))
      setAdded(project)
      useThreads.getState().addProject(project)
      const thread = await call("threads.create", { projectId: project.id })
      useThreads.getState().upsert(thread)
      router.replace({ pathname: "/thread/[id]", params: { id: thread.id } })
    } catch (cause) {
      setError(errorText(cause))
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: theme.background }]}
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <Field
          id="project-source"
          label={copy("mobile_project_source_label")}
          value={source}
          onChangeText={(text) => {
            setSource(text)
            setCloneTo(null)
            setAdded(null)
          }}
          placeholder={copy("mobile_project_source_placeholder")}
          monospace
          autoFocus
          editable={!busy}
          returnKeyType={ready ? "go" : "next"}
          onSubmitEditing={() => void submit()}
        />
        {repository !== null && (
          <View style={styles.repository}>
            <Icon name="RiGithubFill" size={14} color={theme.textMuted} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              {copy("mobile_project_repository", { repository: `${repository.owner}/${repository.name}` })}
            </Text>
          </View>
        )}
        {repository !== null && (
          <Field
            id="project-clone-to"
            label={copy("mobile_project_clone_to")}
            value={cloneFolder}
            onChangeText={setCloneTo}
            monospace
            editable={!busy}
            returnKeyType="go"
            onSubmitEditing={() => void submit()}
          />
        )}
        <Field
          id="project-name"
          label={copy("mobile_project_name")}
          optional
          value={name}
          onChangeText={setName}
          placeholder={namePlaceholder}
          editable={!busy}
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {copy(repository === null ? "mobile_project_folder_hint" : "mobile_project_clone_hint")}
        </Text>
        {error !== null && <Notice text={error} tone="danger" />}
        <Button
          testID="add-project-submit"
          label={copy(repository === null ? "mobile_project_add" : "mobile_project_clone")}
          icon={repository === null ? "RiFolderAddLine" : "RiGithubFill"}
          variant="primary"
          busy={busy}
          disabled={!ready}
          onPress={() => void submit()}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function Field({
  id,
  label,
  optional = false,
  monospace = false,
  ...input
}: TextInputProps & { id: string; label: string; optional?: boolean; monospace?: boolean }) {
  const theme = useTheme()
  return (
    <View style={styles.field}>
      <Text nativeID={`${id}-label`} style={[styles.label, { color: theme.text }]}>
        {label}
        {optional && (
          <Text style={[styles.optional, { color: theme.textMuted }]}> {copy("mobile_project_optional")}</Text>
        )}
      </Text>
      <TextInput
        testID={id}
        accessibilityLabel={label}
        accessibilityLabelledBy={`${id}-label`}
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        style={[
          styles.input,
          monospace && styles.mono,
          { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border },
        ]}
        {...input}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  form: { gap: 16, padding: 20 },
  field: { gap: 8 },
  label: { fontSize: 14, fontWeight: "600" },
  optional: { fontWeight: "400" },
  input: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  mono: { fontFamily: mono, fontSize: 14 },
  repository: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: -8 },
  hint: { fontSize: 13, lineHeight: 18 },
})
