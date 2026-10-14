Feature: Workspace refresh after agent activity
  Files, completions, diffs and commits follow the open thread's turn without a manual refresh.

  Scenario: Changes refresh when a turn starts
    Given a project "refresh" for my repository
    When I create a thread titled "Diff refresh" in "refresh" in a new worktree
    Then the workspace status becomes "Ready"
    When I show the "Changes" side panel view
    Then the Changes view is empty
    When I change "README.md" and add "fresh.txt" in the worktree
    And the open thread starts a turn
    Then the changes list "README.md" as modified and "fresh.txt" as added
    When the open thread finishes its turn
    And I open the diff of "README.md"
    Then the diff of "README.md" shows "change"

  Scenario: Git refresh follows the active thread when two threads share a root
    Given a project "refresh" for my repository
    And the project "refresh" has a thread "First"
    And the project "refresh" has a thread "Second"
    When I open the thread "First" from the sidebar
    And I show the "Git" side panel view
    Then the commit graph lists "init"
    When I open the thread "Second" from the sidebar
    And I show the "Git" side panel view
    Then the commit graph lists "init"
    When I commit "after turn" in my repository
    And the open thread starts a turn
    And the open thread finishes its turn
    Then the commit graph lists "after turn"

  Scenario: Finishing a turn refreshes file completions and git marks
    Given a project "refresh" for my repository
    And the project "refresh" has a thread "Files refresh"
    And I append "uncommitted" to "README.md" in my repository
    When I open the thread "Files refresh" from the sidebar
    And I open Files in the activity bar
    Then the file tree marks "README.md" as modified and ".env" as ignored
    When the open thread starts a turn
    And the file "added-during-turn.txt" contains "new file" in my repository
    And I commit "files completed" in my repository
    And the open thread finishes its turn
    Then the file tree shows "README.md" as unchanged
    And mentioning a file offers "added-during-turn.txt"
