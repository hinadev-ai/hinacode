Feature: Projects
  A project is a local repository the user adds once and finds again in the sidebar on every start.

  Scenario: Adding a project through the dialog lists it in the sidebar
    When I add a project named "demo" for my repository through the dialog
    Then the sidebar lists the project "demo"
    And the project "demo" is stored with my repository path

  Scenario: A folder that does not exist yet is created
    When I add a project named "fresh" at a path that does not exist
    Then the sidebar lists the project "fresh"
    And the project "fresh" has a folder on disk

  Scenario: A root path that is a file is refused with a reason
    When I try to add a project named "ghost" at a path that is a file
    Then the add project dialog shows the error "That path is a file or not a full path. Enter a folder path such as ~/code/app."

  Scenario: A folder another project already uses is refused with a reason
    Given a project "demo" for my repository
    When I try to add another project named "dup" for my repository
    Then the add project dialog shows the error "Another project already uses this folder."
