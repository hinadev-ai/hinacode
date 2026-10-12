Feature: Projects
  A project is a local repository the user adds once and finds again in the sidebar on every start.

  Scenario: Adding a project through the dialog lists it in the sidebar
    When I add a project named "demo" for my repository through the dialog
    Then the sidebar lists the project "demo"
    And the project "demo" is stored with my repository path

  Scenario: A root path that is not a directory is refused with a reason
    When I try to add a project named "ghost" at a path that does not exist
    Then the add project dialog shows the error "That path is not a folder. Pick an existing folder."

  Scenario: A folder another project already uses is refused with a reason
    Given a project "demo" for my repository
    When I try to add another project named "dup" for my repository
    Then the add project dialog shows the error "Another project already uses this folder."

  Scenario: Projects and their threads survive a restart
    Given a project "demo" for my repository
    And the project "demo" has a thread "Fix login"
    When the app restarts
    Then the sidebar lists the project "demo"
    And the sidebar lists the thread "Fix login"
