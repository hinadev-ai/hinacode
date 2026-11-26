package main

import (
	"bufio"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

type tlsRelay struct {
	address string
	config  *tls.Config
}

func startTLSRelay(b *testing.B) tlsRelay {
	b.Helper()
	server := httptest.NewUnstartedServer(NewRelay(testToken, DefaultLimits, slog.New(slog.DiscardHandler)))
	server.Config = newServer(config{}, server.Config.Handler)
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.TLS = server.Config.TLSConfig
	server.StartTLS()
	b.Cleanup(server.Close)
	config := server.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	config.ServerName = "example.com"
	return tlsRelay{address: server.Listener.Addr().String(), config: config}
}

func (r tlsRelay) dial(head string) (net.Conn, *bufio.Reader, error) {
	conn, err := tls.Dial("tcp", r.address, r.config)
	if err != nil {
		return nil, nil, err
	}
	if _, err := io.WriteString(conn, head); err != nil {
		return nil, nil, err
	}
	reader := bufio.NewReaderSize(conn, 64<<10)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		return nil, nil, err
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		return nil, nil, fmt.Errorf("answered %d", response.StatusCode)
	}
	return conn, reader, nil
}

func (r tlsRelay) open(b *testing.B, head string) (net.Conn, *bufio.Reader) {
	conn, reader, err := r.dial(head)
	if err != nil {
		b.Fatal(err)
	}
	return conn, reader
}

func (r tlsRelay) keepMachineAttached(b *testing.B, idle int) {
	for range idle {
		r.parkEcho(b)
	}
}

func (r tlsRelay) parkEcho(b *testing.B) {
	go r.serveEcho(r.open(b, attachHead(testToken)))
}

func (r tlsRelay) replaceParked() {
	if conn, reader, err := r.dial(attachHead(testToken)); err == nil {
		r.serveEcho(conn, reader)
	}
}

func (r tlsRelay) serveEcho(conn net.Conn, reader *bufio.Reader) {
	for {
		signal, err := reader.ReadByte()
		if err != nil {
			return
		}
		if signal == signalPing {
			conn.Write([]byte{signalPing})
			continue
		}
		go r.replaceParked()
		conn.Write([]byte{signalOpen})
		if _, err := http.ReadRequest(reader); err != nil {
			return
		}
		io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		io.Copy(conn, reader)
		conn.Close()
		return
	}
}

func BenchmarkConnect(b *testing.B) {
	relay := startTLSRelay(b)
	relay.keepMachineAttached(b, 2)
	for b.Loop() {
		conn, _ := relay.open(b, clientHead)
		conn.Close()
	}
}

func BenchmarkSmallEcho(b *testing.B) {
	relay := startTLSRelay(b)
	relay.keepMachineAttached(b, 1)
	conn, reader := relay.open(b, clientHead)
	defer conn.Close()
	message := make([]byte, 64)
	for b.Loop() {
		conn.Write(message)
		if _, err := io.ReadFull(reader, message); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkStream(b *testing.B) {
	relay := startTLSRelay(b)
	relay.keepMachineAttached(b, 1)
	conn, reader := relay.open(b, clientHead)
	defer conn.Close()
	chunk := make([]byte, 1<<20)
	b.SetBytes(int64(len(chunk)))
	go func() {
		for {
			if _, err := conn.Write(chunk); err != nil {
				return
			}
		}
	}()
	sink := make([]byte, len(chunk))
	for b.Loop() {
		if _, err := io.ReadFull(reader, sink); err != nil {
			b.Fatal(err)
		}
	}
}
