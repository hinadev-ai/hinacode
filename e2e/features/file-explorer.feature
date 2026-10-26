Feature: File explorer
  The Files view lists where the thread works as a tree, marks what changed and what git ignores,
  and opens a file read-only, all from the keyboard.

  Scenario: Browse the project root and open a file with the keyboard
    Given a project "fx" for my repository
    And I append "explorer edit" to "README.md" in my repository
    When I start a new thread in "fx"
    Then a new thread is open with the composer focused
    When I press "ControlOrMeta+Shift+E"
    Then the file tree has focus
    And the file tree marks "README.md" as modified and ".env" as ignored
    When I type "rea" in the file tree and press Enter
    Then the file viewer shows "README.md" with "explorer edit"
    When I press Escape in the file tree
    Then the file viewer is closed

  Scenario: An open file reloads after its folder is collapsed
    Given a project "fx" for my repository
    And the file "src/viewer.txt" contains "before edit" in my repository
    When I start a new thread in "fx"
    And I open Files in the activity bar
    And I click "src" in the file tree
    And I click "viewer.txt" in the file tree
    Then the file viewer shows "src/viewer.txt" with "before edit"
    When I click "src" in the file tree
    And I append "after collapse" to "src/viewer.txt" while browsing files
    Then the file viewer shows "src/viewer.txt" with "after collapse"

  Scenario: A markdown file opens rendered, with its source one click away
    Given a project "fx" for my repository
    And the file "docs/guide.md" contains "# Markdown guide" in my repository
    And I append "![Logo](logo.png)" to "docs/guide.md" in my repository
    And the image "docs/logo.png" exists in my repository
    When I start a new thread in "fx"
    And I open Files in the activity bar
    And I click "docs" in the file tree
    And I click "guide.md" in the file tree
    Then the file viewer renders the heading "Markdown guide" and the image "Logo"
    When I click "Source" in the file viewer
    Then the file viewer shows "docs/guide.md" with "# Markdown guide"
    When I click "Preview" in the file viewer
    Then the file viewer renders the heading "Markdown guide" and the image "Logo"
