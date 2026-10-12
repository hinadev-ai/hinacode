Feature: File explorer
  The Files view lists where the thread works as a tree, marks what changed and what git ignores,
  and opens a file read-only, all from the keyboard.

  Scenario: Browse the project root and open a file with the keyboard
    Given a project "fx" for my repository
    And I append "explorer edit" to "README.md" in my repository
    When I start a new thread in "fx"
    And I press "ControlOrMeta+Shift+E"
    Then the file tree has focus
    And the file tree marks "README.md" as modified and ".env" as ignored
    When I type "rea" in the file tree and press Enter
    Then the file viewer shows "README.md" with "explorer edit"
    When I press Escape in the file tree
    Then the file viewer is closed
