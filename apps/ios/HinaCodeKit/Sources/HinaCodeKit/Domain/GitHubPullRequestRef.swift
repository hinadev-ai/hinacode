import Foundation

/// A GitHub repository, `owner/name`. The type itself is generated with the wire contract.
extension GitHubRepository {
    /// The repository `input` names, as `owner/repo`, a github.com URL (https, ssh, or a link into the repository),
    /// or a pasted `git clone` or `gh repo clone` command. Nil for local paths and anything else.
    public init?(parsing input: String) {
        var text = Substring(input.trimmingCharacters(in: .whitespacesAndNewlines))
        if let command = text.prefixMatch(of: /(?:git\s+clone|gh\s+repo\s+clone)\s+/) {
            text = text[command.range.upperBound...]
        }
        let forms = [
            #/(?:https?://)?(?:www\.)?github\.com/([^/]+)/([^/]+)(?:/.*)?/#,
            #/git@github\.com:([^/]+)/([^/]+)/#,
            #/ssh://git@github\.com/([^/]+)/([^/]+)/#,
            #/([^/]+)/([^/]+)/#,
        ]
        // The first form that matches decides, even when its owner or name is invalid.
        guard let match = forms.lazy.compactMap({ text.wholeMatch(of: $0) }).first else { return nil }
        var name = match.output.2
        if name.hasSuffix(".git") { name.removeLast(4) }
        guard match.output.1.wholeMatch(of: /[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/) != nil,
            name != ".", name != "..", name.wholeMatch(of: /[A-Za-z0-9._-]+/) != nil
        else { return nil }
        self.init(owner: String(match.output.1), name: String(name))
    }
}

/// A pull request on github.com.
public struct GitHubPullRequestRef: Hashable, Sendable {
    public let owner: String
    public let repository: String
    /// The digits as the URL has them.
    public let number: String

    /// Canonical `https://github.com/<owner>/<repo>/pull/<n>`.
    public var url: String { "https://github.com/\(owner)/\(repository)/pull/\(number)" }

    /// Reads an https github.com pull request URL, ignoring sub-pages like `/files` and any query or hash.
    public init?(url: String) {
        guard let components = URLComponents(string: url), components.scheme?.lowercased() == "https",
            let host = components.host?.lowercased(), host == "github.com" || host == "www.github.com",
            let match = components.percentEncodedPath.wholeMatch(
                of: #/\/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/([0-9]+)(?:/.*)?/#)
        else { return nil }
        owner = String(match.output.1)
        repository = String(match.output.2)
        number = String(match.output.3)
    }

    /// The same pull request on linear.review, which serves GitHub's paths, sub-pages included. Any other url is
    /// returned as is.
    public static func linearReviewUrl(_ url: String) -> String {
        let pullRequest = #/https://github\.com/(?=[^/]+/[^/]+/pull/[0-9]+)/#.ignoresCase()
        guard let match = url.prefixMatch(of: pullRequest) else { return url }
        return "https://linear.review/" + url[match.range.upperBound...]
    }
}

extension CheckoutTarget {
    /// What the developer typed as a workspace ref: a pull request number (`123` or `#123`) or URL, else a branch.
    public init(workspaceRef ref: String) {
        let text = ref.trimmingCharacters(in: .whitespacesAndNewlines)
        if let number = text.wholeMatch(of: /#?([1-9][0-9]*)/) {
            self = .pullRequest(.init(selector: String(number.output.1)))
        } else if let pullRequest = GitHubPullRequestRef(url: text) {
            self = .pullRequest(.init(selector: pullRequest.url))
        } else {
            self = .branch(.init(ref: text))
        }
    }
}
