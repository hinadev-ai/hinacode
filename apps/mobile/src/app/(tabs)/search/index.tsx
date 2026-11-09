import { Stack } from "expo-router"
import { useState } from "react"
import { StyleSheet, View } from "react-native"
import { isIOS } from "@/components/glass"
import { SearchField } from "@/components/search-field"
import { ThreadFilterPill } from "@/components/thread-filter"
import { ScopeChips, SearchResults, type SearchScope } from "@/components/thread-search"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

/**
 * Threads and messages that match. On iOS the search tab focuses the header's search bar as it opens. Elsewhere the
 * field sits at the top, where the keyboard cannot cover it.
 */
export default function SearchScreen() {
  const theme = useTheme()
  const [query, setQuery] = useState("")
  const [scope, setScope] = useState<SearchScope>("all")

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      {isIOS ? (
        <Stack.SearchBar
          placeholder={copy("mobile_search_placeholder")}
          autoCapitalize="none"
          onChangeText={(event) => setQuery(event.nativeEvent.text)}
          onCancelButtonPress={() => setQuery("")}
        />
      ) : (
        <View style={styles.field}>
          <SearchField
            testID="thread-search"
            value={query}
            onChange={setQuery}
            placeholder={copy("mobile_search_placeholder")}
            clearLabel={copy("mobile_search_clear")}
          />
        </View>
      )}
      <SearchResults
        query={query}
        scope={scope}
        nativeHeader={isIOS}
        header={
          <>
            <ScopeChips value={scope} onChange={setScope} />
            <View style={styles.filter}>
              <ThreadFilterPill />
            </View>
          </>
        }
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  field: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  filter: { alignItems: "flex-start", paddingHorizontal: 8, paddingVertical: 6 },
})
