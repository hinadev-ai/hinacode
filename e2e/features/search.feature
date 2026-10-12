Feature: Search
  Repeating a search reads messages and workspace files added since the previous search.

  # Settled results were cached by query forever; reopening after agent edits must read both sources again.
  Scenario: Reopening global search refreshes the same query
    Given a project "demo" for my repository
    And the project "demo" has a thread "Search results"
    And the thread "Search results" and its workspace each have 1 search match
    When I open the thread "Search results" from the sidebar
    And I press "ControlOrMeta+Shift+f"
    And I search for the refresh query
    Then global search shows 2 results
    When I press "Escape"
    And the thread "Search results" and its workspace each have 2 search matches
    And I press "ControlOrMeta+Shift+f"
    And I search for the refresh query
    Then global search shows 4 results
