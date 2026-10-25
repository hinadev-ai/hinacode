import Foundation
import Testing

@testable import HinaCodeKit

private func object(_ text: String) throws -> [String: JSONValue] {
    try JSONDecoder().decode([String: JSONValue].self, from: Data(text.utf8))
}

@Suite("remote frames")
struct RemoteFrameTests {
    @Test("keeps known capabilities when ready advertises a future feature")
    func futureFeature() throws {
        let frame = IncomingFrame(text: #"{"type":"ready","version":1,"features":["heartbeat","some-future-feature"]}"#)
        #expect(frame == .ready(.init(version: 1, features: ["heartbeat", "some-future-feature"])))
        guard case .ready(let ready) = frame else { throw RpcError("Test", "Expected ready frame") }
        #expect(ready.features.contains("heartbeat"))
    }

    @Test("accepts a future method without dropping its call key")
    func futureMethod() throws {
        let text = ClientFrame.call(id: 1, method: "future.method", payload: nil, key: "action-1").text
        #expect(
            try object(text) == [
                "type": .string("call"), "id": .number(1), "method": .string("future.method"),
                "key": .string("action-1"),
            ])
    }

    @Test("decodes application heartbeats and the advertised features")
    func heartbeats() throws {
        #expect(try object(ClientFrame.ping(at: 123).text) == ["type": .string("ping"), "at": .number(123)])
        #expect(IncomingFrame(text: #"{"type":"pong","at":123}"#) == .pong)
        #expect(
            IncomingFrame(text: #"{"type":"ready","version":1,"features":["heartbeat","call-keys"]}"#)
                == .ready(.init(version: 1, features: ["heartbeat", "call-keys"])))
        #expect(IncomingFrame(text: #"{"type":"ready","version":1}"#) == .ready(.init(version: 1, features: [])))
    }

    @Test("reads a frame the schema would reject as unreadable, and a push this build does not list as unknown")
    func unreadable() {
        for text in [
            "not json", "[]", #"{"type":"future"}"#, #"{"type":"challenge"}"#, #"{"type":"ready","version":1.5}"#,
            #"{"type":"ready","version":1,"relay":null}"#, #"{"type":"result","id":1,"envelope":[]}"#,
            #"{"type":"pong"}"#, #"{"type":"event","event":{"type":"thread.removed"}}"#,
        ] {
            #expect(IncomingFrame(text: text) == .unreadable, "\(text)")
        }
        #expect(
            IncomingFrame(text: #"{"type":"event","event":{"type":"future.push"}}"#) == .event(.unknown("future.push")))
    }

    @Test("decodes a result frame's answer, a void answer, and an error")
    func envelopes() throws {
        func decode<Response: Decodable>(_ type: Response.Type, _ text: String) throws -> Result<Response, RpcError> {
            guard case .result(1, let frame) = IncomingFrame(text: text) else {
                throw RpcError("Test", "Expected result")
            }
            return try JSONDecoder().decode(ResultEnvelope<Response>.self, from: frame).result
        }
        #expect(try decode([String].self, #"{"type":"result","id":1,"envelope":{"result":["a"]}}"#) == .success(["a"]))
        #expect(try decode(NoPayload.self, #"{"type":"result","id":1,"envelope":{}}"#) == .success(NoPayload()))
        #expect(try decode(String?.self, #"{"type":"result","id":1,"envelope":{"result":null}}"#) == .success(nil))
        #expect(
            try decode(
                NoPayload.self, #"{"type":"result","id":1,"envelope":{"error":{"tag":"NotFound","message":"Gone"}}}"#)
                == .failure(RpcError("NotFound", "Gone")))
    }
}
