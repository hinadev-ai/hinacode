import HinaCodeKit
import SwiftUI

/// Questions the agent is waiting on, floating above the composer on glass. Options toggle for multi-select
/// questions and replace for single-select ones; typed text is appended to the picked labels.
struct QuestionCard: View {
    let request: QuestionRequest

    @Environment(AppModel.self) private var model
    @State private var picked: [String: [String]] = [:]
    @State private var typed: [String: String] = [:]
    @State private var busy = false
    @State private var error: String?
    @State private var answered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(request.questions) { question in
                QuestionSection(
                    question: question,
                    picked: Binding(
                        get: { picked[question.id] ?? [] },
                        set: { picked[question.id] = $0.isEmpty ? nil : $0 }),
                    typed: Binding(
                        get: { typed[question.id] ?? "" },
                        set: { typed[question.id] = $0 }))
            }
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                Button {
                    respond([:])
                } label: {
                    Text(.mobileChatSkip)
                }
                .buttonStyle(.glass)
                .disabled(busy)
                Button {
                    respond(answers)
                } label: {
                    if busy {
                        ProgressView()
                    } else {
                        Text(.mobileChatSubmit)
                    }
                }
                .buttonStyle(.glassProminent)
                .disabled(busy || answers.isEmpty)
            }
            if let error {
                Text(verbatim: error)
                    .font(.footnote)
                    .foregroundStyle(Tone.danger.color)
            }
        }
        .padding(12)
        .glassEffect(.regular.tint(Tone.attention.color.opacity(0.15)), in: .rect(cornerRadius: 18))
        .sensoryFeedback(.success, trigger: answered)
        .accessibilityElement(children: .contain)
    }

    private var answers: [String: [String]] {
        var result: [String: [String]] = [:]
        for question in request.questions {
            var values = picked[question.id] ?? []
            let text = (typed[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { values.append(text) }
            if !values.isEmpty { result[question.id] = values }
        }
        return result
    }

    private func respond(_ answers: [String: [String]]) {
        busy = true
        error = nil
        Task {
            do {
                _ = try await model.hub.call(
                    RPC.questionsRespond, QuestionsRespondRequest(requestId: request.id, answers: answers))
                answered = true
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

private struct QuestionSection: View {
    let question: Question
    @Binding var picked: [String]
    @Binding var typed: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: title)
                .font(.subheadline.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            ForEach(question.options, id: \.label) { option in
                Button {
                    toggle(option.label)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: option.label)
                            .font(.body.weight(.semibold))
                        if !option.description.isEmpty {
                            Text(verbatim: option.description)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(.bordered)
                .tint(picked.contains(option.label) ? Color.accentColor : Color.secondary)
                .accessibilityAddTraits(picked.contains(option.label) ? .isSelected : [])
            }
            if question.allowsText {
                Group {
                    if question.secret {
                        SecureField(text: $typed) { Text(.mobileChatAnswerPlaceholder) }
                    } else {
                        TextField(text: $typed) { Text(.mobileChatAnswerPlaceholder) }
                    }
                }
                .textFieldStyle(.roundedBorder)
                .frame(minHeight: 44)
                .accessibilityLabel(Text(.mobileChatAnswerLabel(question.question)))
            }
        }
    }

    private var title: String {
        question.header.isEmpty ? question.question : "\(question.header): \(question.question)"
    }

    private func toggle(_ label: String) {
        if question.multiSelect {
            if picked.contains(label) {
                picked.removeAll { $0 == label }
            } else {
                picked.append(label)
            }
        } else {
            picked = [label]
        }
    }
}
