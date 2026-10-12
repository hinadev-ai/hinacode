Feature: Ports
  The thread details panel lists TCP ports held by processes running in the thread's workspace,
  so a dev server an agent started and forgot can be found and stopped.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Server"
    And I open the thread "Server" from the sidebar

  Scenario: A server listening from the workspace is listed and can be stopped in two clicks
    When a server starts listening from my repository
    Then the ports panel lists the server from my repository
    When I stop the server from my repository in the ports panel
    Then the server from my repository has exited
    And the ports panel is empty

  Scenario: A server listening elsewhere is not attributed to the thread
    When a server starts listening outside my repository
    And a server starts listening from my repository
    Then the ports panel lists the server from my repository
    And the ports panel does not list the server from outside my repository
