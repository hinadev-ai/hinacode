package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const (
	testToken = "0123456789abcdef0123456789abcdef"
	testHost  = "machine-0123456789"
)

func startRelay(t *testing.T, limits Limits) string {
	t.Helper()
	server := httptest.NewUnstartedServer(NewRelay(testToken, limits, slog.New(slog.DiscardHandler)))
	server.Config = newServer(config{}, server.Config.Handler)
	server.Start()
	t.Cleanup(server.Close)
	return server.Listener.Addr().String()
}

func request(t *testing.T, address, head string) (net.Conn, *bufio.Reader, *http.Response) {
	t.Helper()
	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if _, err := io.WriteString(conn, head); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	return conn, reader, response
}

func attachHead(token string) string {
	return "GET /h/" + testHost + "/attach HTTP/1.1\r\nHost: relay\r\nAuthorization: Bearer " + token +
		"\r\nConnection: Upgrade\r\nUpgrade: " + upgradeProtocol + "\r\n\r\n"
}

const clientHead = "GET /h/" + testHost + "/remote HTTP/1.1\r\nHost: relay.example\r\nConnection: Upgrade\r\n" +
	"Upgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"

type machine struct {
	conn     net.Conn
	reader   *bufio.Reader
	requests chan *http.Request
}

func attachMachine(t *testing.T, address string) *machine {
	t.Helper()
	conn, reader, response := request(t, address, attachHead(testToken))
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("attach answered %d", response.StatusCode)
	}
	return &machine{conn: conn, reader: reader, requests: make(chan *http.Request, 1)}
}

func (m *machine) serveEcho() {
	for {
		signal, err := m.reader.ReadByte()
		if err != nil {
			return
		}
		if signal == signalPing {
			m.conn.Write([]byte{signalPing})
			continue
		}
		m.conn.Write([]byte{signalOpen})
		forwarded, err := http.ReadRequest(m.reader)
		if err != nil {
			return
		}
		m.requests <- forwarded
		io.WriteString(m.conn, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		io.Copy(m.conn, m.reader)
		return
	}
}

func TestClientReachesMachineThroughRelay(t *testing.T) {
	address := startRelay(t, DefaultLimits)
	m := attachMachine(t, address)
	go m.serveEcho()

	conn, reader, response := request(t, address, clientHead)
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("client upgrade answered %d", response.StatusCode)
	}
	forwarded := <-m.requests
	if forwarded.URL.Path != "/remote" || forwarded.Host != "relay.example" {
		t.Fatalf("machine saw %s on host %s", forwarded.URL.Path, forwarded.Host)
	}
	if forwarded.Header.Get("Sec-WebSocket-Key") != "dGhlIHNhbXBsZSBub25jZQ==" {
		t.Fatal("machine lost the WebSocket key")
	}

	payload := make([]byte, 4<<20)
	rand.Read(payload)
	go conn.Write(payload)
	echoed := make([]byte, len(payload))
	if _, err := io.ReadFull(reader, echoed); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(payload, echoed) {
		t.Fatal("echo differs from what the client sent")
	}
}

func TestOnlyTokenHoldersAttach(t *testing.T) {
	address := startRelay(t, DefaultLimits)
	for _, token := range []string{"", "wrong-token-wrong-token-wrong-token", testToken + "x"} {
		_, _, response := request(t, address, attachHead(token))
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("token %q attached with %d", token, response.StatusCode)
		}
	}
	_, _, response := request(t, address, clientHead)
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("a client reached a machine that never attached: %d", response.StatusCode)
	}
}

func TestClientSkipsAClosedIdleConnection(t *testing.T) {
	address := startRelay(t, DefaultLimits)
	gone := attachMachine(t, address)
	live := attachMachine(t, address)
	go live.serveEcho()
	gone.conn.Close()
	time.Sleep(50 * time.Millisecond)

	_, _, response := request(t, address, clientHead)
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("client upgrade answered %d", response.StatusCode)
	}
}

func TestSilentMachineIsDropped(t *testing.T) {
	limits := DefaultLimits
	limits.PingEvery = 20 * time.Millisecond
	limits.DeadAfter = 60 * time.Millisecond
	limits.WaitForMachine = 50 * time.Millisecond
	address := startRelay(t, limits)
	silent := attachMachine(t, address)

	silent.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.Copy(io.Discard, silent.reader); err != nil {
		t.Fatalf("relay never closed the silent machine: %v", err)
	}
	_, _, response := request(t, address, clientHead)
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("client reached a dropped machine: %d", response.StatusCode)
	}
}

func TestRelayRejectsPlainRequestsToAMachine(t *testing.T) {
	address := startRelay(t, DefaultLimits)
	m := attachMachine(t, address)
	go m.serveEcho()
	_, _, response := request(t, address, "GET /h/"+testHost+"/remote HTTP/1.1\r\nHost: relay\r\n\r\n")
	if response.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("plain request answered %d", response.StatusCode)
	}
}
