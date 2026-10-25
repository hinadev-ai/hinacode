import Foundation
import HinaCodeKit
import Testing

@Suite("pairing URLs")
struct PairingTargetTests {
    @Test("round-trips every host in order")
    func hostsInOrder() {
        let target = PairingTarget(
            hosts: ["100.64.0.2", "192.168.1.5", "mac.local", "fd7a:115c::2"], port: 47821, token: "t/k+n", relay: nil)
        #expect(
            target.url
                == "hinacode://connect?host=100.64.0.2&host=192.168.1.5&host=mac.local&host=fd7a%3A115c%3A%3A2&port=47821&token=t%2Fk%2Bn"
        )
        #expect(PairingTarget.parse(target.url) == target)
    }

    @Test("reads the single-host form that older desktops print")
    func singleHost() {
        #expect(
            PairingTarget.parse(" hinacode://connect?host=192.168.1.5&port=47821&token=abc\n")
                == PairingTarget(hosts: ["192.168.1.5"], port: 47821, token: "abc", relay: nil))
    }

    @Test("round-trips the relay ahead of the hosts")
    func relayFirst() {
        let target = PairingTarget(
            hosts: ["100.64.0.2"], port: 47821, token: "abc", relay: "hinacode-1a2b3c4d.example.com")
        #expect(
            target.url == "hinacode://connect?relay=hinacode-1a2b3c4d.example.com&host=100.64.0.2&port=47821&token=abc")
        #expect(PairingTarget.parse(target.url) == target)
    }

    @Test("finds the URL inside the lines hinacode serve prints")
    func servePrintout() {
        let printed = [
            "hinacode serve is listening on port 47821",
            "pair a desktop with one of:",
            "  hinacode://connect?host=100.64.0.2&host=192.0.2.10&port=47821&token=abc",
            "  hinacode://connect?host=192.0.2.10&port=47821&token=abc",
        ].joined(separator: "\n")
        #expect(
            PairingTarget.parse(printed)
                == PairingTarget(hosts: ["100.64.0.2", "192.0.2.10"], port: 47821, token: "abc", relay: nil))
    }

    @Test("finds the URL between words on one line")
    func betweenWords() {
        #expect(
            PairingTarget.parse("pair with hinacode://connect?host=a&port=1&token=t\tthen connect")
                == PairingTarget(hosts: ["a"], port: 1, token: "t", relay: nil))
    }

    @Test(
        "refuses",
        arguments: [
            ("text without a pairing URL", "pair a desktop with one of:"),
            ("a pairing URL glued to a word", "url:hinacode://connect?host=a&port=1&token=t"),
            ("another scheme", "https://connect?host=a&port=1&token=t"),
            ("another action", "hinacode://pair?host=a&port=1&token=t"),
            ("no host", "hinacode://connect?port=1&token=t"),
            ("an empty host", "hinacode://connect?host=a&host=&port=1&token=t"),
            ("a host with a path", "hinacode://connect?host=a%2Fb&port=1&token=t"),
            ("a host with credentials", "hinacode://connect?host=evil%40a&port=1&token=t"),
            ("a bracketed host", "hinacode://connect?host=%5B%3A%3A1%5D&port=1&token=t"),
            ("an invalid IPv6 address", "hinacode://connect?host=1%3A%3A2%3A%3A3&port=1&token=t"),
            ("a port out of range", "hinacode://connect?host=a&port=65536&token=t"),
            ("no token", "hinacode://connect?host=a&port=1"),
            ("a relay with a port", "hinacode://connect?relay=r.example.com%3A8443&host=a&port=1&token=t"),
            ("a relay with a path", "hinacode://connect?relay=r.example.com%2Fx&host=a&port=1&token=t"),
            ("a relay that is not a domain name", "hinacode://connect?relay=localhost&host=a&port=1&token=t"),
        ])
    func refuses(_ reason: String, _ text: String) {
        #expect(PairingTarget.parse(text) == nil, "\(reason)")
    }

    @Test("brackets an IPv6 host in the socket URL")
    func bracketsIPv6() {
        let target = PairingTarget(hosts: ["fd7a:115c::2", "mac.local"], port: 47821, token: "t", relay: nil)
        #expect(
            target.dialPlan.map(\.url.absoluteString) == [
                "ws://[fd7a:115c::2]:47821/remote", "ws://mac.local:47821/remote",
            ])
    }

    @Test("dials the direct addresses at once and the relay a moment later")
    func plan() throws {
        let target = PairingTarget(hosts: ["100.64.0.2", "mac.local"], port: 47821, token: "t", relay: "r.example.com")
        #expect(
            target.dialPlan == [
                Dial(url: try #require(URL(string: "ws://100.64.0.2:47821/remote")), route: .direct, delay: .zero),
                Dial(url: try #require(URL(string: "ws://mac.local:47821/remote")), route: .direct, delay: .zero),
                Dial(
                    url: try #require(URL(string: "wss://r.example.com/remote")), route: .relay,
                    delay: Remote.relayDelay),
            ])
        #expect(
            PairingTarget(hosts: ["mac.local"], port: 47821, token: "t", relay: nil).dialPlan == [
                Dial(url: try #require(URL(string: "ws://mac.local:47821/remote")), route: .direct, delay: .zero)
            ])
    }
}
