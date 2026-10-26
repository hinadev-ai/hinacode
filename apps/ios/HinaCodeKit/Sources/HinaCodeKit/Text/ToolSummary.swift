extension JSONValue {
    /// The first line of the argument that says what a tool call does: its command, path, pattern, URL or
    /// description. Nil for input without one.
    public var toolSummary: String? {
        guard case .object(let fields) = self else { return nil }
        for key in ["command", "file_path", "path", "pattern", "url", "description"] {
            if case .string(let value) = fields[key] {
                let firstLine = value.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? value
                if !firstLine.isEmpty { return firstLine }
            }
        }
        return nil
    }
}
