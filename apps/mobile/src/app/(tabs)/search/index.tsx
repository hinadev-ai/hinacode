import { Stack } from "expo-router"
import { useState } from "react"
import { StyleSheet, View } from "react-native"
import { isIOS } from "@/components/glass"
import { SearchField } from "@/components/search-field"
import { ServerFilter } from "@/components/server-filter"
import { SearchResults } from "@/components/thread-search"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

/** Threads and messages that match. On iOS the search tab focuses the header's search bar as it opens. */
export default function SearchScreen() {
  const theme = useTheme()
  const [query, setQuery] = useState("")
  const searching = query.trim() !== ""

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
      {searching && <SearchResults query={query} nativeHeader={isIOS} header={<ServerFilter />} />}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  field: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 },
})
