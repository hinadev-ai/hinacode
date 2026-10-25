import HinaCodeKit
import Testing

struct GitHubRepositoryTests {
    @Test func `reads owner/repo in every form people paste`() {
        let repository = GitHubRepository(owner: "kjj6198", name: "myprofile")
        for input in [
            "kjj6198/myprofile",
            "  kjj6198/myprofile  ",
            "https://github.com/kjj6198/myprofile",
            "https://github.com/kjj6198/myprofile.git",
            "https://github.com/kjj6198/myprofile/",
            "http://www.github.com/kjj6198/myprofile",
            "github.com/kjj6198/myprofile",
            "https://github.com/kjj6198/myprofile/tree/main/src",
            "https://github.com/kjj6198/myprofile/pull/12",
            "git@github.com:kjj6198/myprofile.git",
            "ssh://git@github.com/kjj6198/myprofile.git",
            "git clone https://github.com/kjj6198/myprofile.git",
            "gh repo clone kjj6198/myprofile",
        ] {
            #expect(GitHubRepository(parsing: input) == repository, "\(input)")
        }
    }

    @Test func `keeps dots, underscores and dashes in repository names`() {
        #expect(GitHubRepository(parsing: "vercel/next.js") == GitHubRepository(owner: "vercel", name: "next.js"))
        #expect(
            GitHubRepository(parsing: "my-org/repo_name-2") == GitHubRepository(owner: "my-org", name: "repo_name-2"))
    }

    @Test func `leaves local paths and anything else alone`() {
        for input in [
            "",
            "/Users/kalan/code/app",
            "~/code/app",
            "./app",
            "../app",
            "C:\\code\\app",
            "code/app/src",
            "kjj6198",
            "kjj6198/..",
            "https://gitlab.com/kjj6198/myprofile",
            "https://github.com/kjj6198",
        ] {
            #expect(GitHubRepository(parsing: input) == nil, "\(input)")
        }
    }
}

struct GitHubPullRequestRefTests {
    @Test func `canonicalizes pull request URLs, dropping sub-pages, queries and hashes`() {
        let canonical = "https://github.com/hinadev-ai/hinacode/pull/12"
        #expect(GitHubPullRequestRef(url: canonical)?.url == canonical)
        #expect(
            GitHubPullRequestRef(url: "https://github.com/hinadev-ai/hinacode/pull/12/files?diff=split#r1")?.url
                == canonical)
        #expect(GitHubPullRequestRef(url: "https://www.github.com/hinadev-ai/hinacode/pull/12/")?.url == canonical)
    }

    @Test func `rejects anything that is not a GitHub pull request`() {
        #expect(GitHubPullRequestRef(url: "https://github.com/hinadev-ai/hinacode/issues/12") == nil)
        #expect(GitHubPullRequestRef(url: "http://github.com/hinadev-ai/hinacode/pull/12") == nil)
        #expect(GitHubPullRequestRef(url: "https://gitlab.com/hinadev-ai/hinacode/pull/12") == nil)
        #expect(GitHubPullRequestRef(url: "https://github.com/hinadev-ai/hinacode/pull/abc") == nil)
        #expect(GitHubPullRequestRef(url: "not a url") == nil)
    }
}

struct LinearReviewUrlTests {
    @Test func `moves a pull request and its subpages to linear.review`() {
        #expect(
            GitHubPullRequestRef.linearReviewUrl("https://github.com/linear/linear/pull/1311")
                == "https://linear.review/linear/linear/pull/1311")
        #expect(
            GitHubPullRequestRef.linearReviewUrl("https://github.com/linear/linear/pull/1311/files")
                == "https://linear.review/linear/linear/pull/1311/files")
    }

    @Test func `leaves other urls alone`() {
        for url in ["https://github.com/linear/linear/issues/4", "https://example.com/a/b/pull/1"] {
            #expect(GitHubPullRequestRef.linearReviewUrl(url) == url)
        }
    }
}
