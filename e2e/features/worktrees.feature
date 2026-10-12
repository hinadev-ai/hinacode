Feature: Worktrees
  A thread can run in its own git worktree. kkcode creates the branch and checkout, runs the
  project's setup script there with the kkcode variables set, shows the script's output and the
  worktree's changes, and removes the checkout when the thread is archived with worktree removal on.

  Scenario: A worktree thread runs the setup script with the project variables
    Given a project "wt" for my repository with the setup script "cp \"$KKCODE_ROOT_PATH/.env\" .env && echo \"setup ok on $KKCODE_BRANCH\""
    When I create a thread titled "wt check" in "wt" in a new worktree
    Then the workspace status becomes "Ready"
    And the setup log ends with the branch of "wt check"
    And the worktree has a copy of my repository's ".env"
    And git lists the worktree on the branch "wt check"

  Scenario: Changes made in the worktree are listed with their diff
    Given a project "wt" for my repository
    When I create a thread titled "wt changes" in "wt" in a new worktree
    And the workspace status becomes "Ready"
    And I change "README.md" and add "new.txt" in the worktree
    And I refresh the changes
    Then the changes list "README.md" as modified and "new.txt" as added
    When I open the diff of "README.md"
    Then the diff of "README.md" shows "change"

  Scenario: A failing setup script marks the worktree as failed and keeps the log
    Given a project "wt-fail" for my repository with the setup script "echo about to fail; exit 3"
    When I create a thread titled "wt fail" in "wt-fail" in a new worktree
    Then the workspace status becomes "Setup failed"
    And the setup log reports that the script exited with code 3

  Scenario: Archiving with worktree removal on deletes the checkout and keeps the unmerged branch
    Given a project "wt" for my repository
    And archiving removes worktrees
    When I create a thread titled "wt archive" in "wt" in a new worktree
    And the workspace status becomes "Ready"
    And I commit a change in the worktree
    And I archive the thread and delete its worktree
    Then the worktree is removed from disk but its branch is kept
