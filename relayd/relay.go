package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	upgradeProtocol = "hinacode-relay/1"

	signalPing = 0x00
	signalOpen = 0x01
)

type Limits struct {
	ParkedPerHost  int
	ActivePerHost  int
	WaitForMachine time.Duration
	PingEvery      time.Duration
	DeadAfter      time.Duration
	CopyBuffer     int
}

var DefaultLimits = Limits{
	ParkedPerHost:  8,
	ActivePerHost:  64,
	WaitForMachine: 5 * time.Second,
	PingEvery:      15 * time.Second,
	DeadAfter:      40 * time.Second,
	CopyBuffer:     16 << 10,
}

var hostID = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

type Relay struct {
	tokenHash [sha256.Size]byte
	limits    Limits
	log       *slog.Logger
	buffers   sync.Pool

	mu    sync.Mutex
	hosts map[string]*host
}

type host struct {
	mu      sync.Mutex
	idle    []*parked
	arrived chan struct{}
	active  atomic.Int32
}

type parked struct {
	conn     net.Conn
	reader   *bufio.Reader
	client   chan net.Conn
	finished chan struct{}
	lastPong atomic.Int64
	mu       sync.Mutex
	claimed  bool
	dead     bool
}

func NewRelay(token string, limits Limits, log *slog.Logger) *Relay {
	r := &Relay{
		tokenHash: sha256.Sum256([]byte(token)),
		limits:    limits,
		log:       log,
		hosts:     map[string]*host{},
	}
	r.buffers.New = func() any {
		buffer := make([]byte, limits.CopyBuffer)
		return &buffer
	}
	return r
}

func (r *Relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if req.URL.Path == "/healthz" {
		w.WriteHeader(http.StatusOK)
		return
	}
	id, action, ok := splitHostPath(req.URL.Path)
	if !ok || !hostID.MatchString(id) {
		http.NotFound(w, req)
		return
	}
	switch action {
	case "attach":
		r.attach(w, req, id)
	case "remote":
		r.connectClient(w, req, id)
	default:
		http.NotFound(w, req)
	}
}

func splitHostPath(path string) (id, action string, ok bool) {
	rest, found := strings.CutPrefix(path, "/h/")
	if !found {
		return "", "", false
	}
	id, action, found = strings.Cut(rest, "/")
	return id, action, found
}

func (r *Relay) authorized(req *http.Request) bool {
	token, found := strings.CutPrefix(req.Header.Get("Authorization"), "Bearer ")
	if !found {
		return false
	}
	given := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(given[:], r.tokenHash[:]) == 1
}

func (r *Relay) hostFor(id string, create bool) *host {
	r.mu.Lock()
	defer r.mu.Unlock()
	h := r.hosts[id]
	if h == nil && create {
		h = &host{arrived: make(chan struct{}, 1)}
		r.hosts[id] = h
	}
	return h
}

func (r *Relay) attach(w http.ResponseWriter, req *http.Request, id string) {
	if !r.authorized(req) {
		r.log.Warn("refused a machine token", "host", id, "from", req.RemoteAddr)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !headerHasToken(req.Header, "Connection", "upgrade") || !strings.EqualFold(req.Header.Get("Upgrade"), upgradeProtocol) {
		http.Error(w, "expected Upgrade: "+upgradeProtocol, http.StatusUpgradeRequired)
		return
	}
	conn, reader, err := hijack(w)
	if err != nil {
		return
	}
	if _, err := io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: "+upgradeProtocol+"\r\n\r\n"); err != nil {
		conn.Close()
		return
	}
	p := &parked{conn: conn, reader: reader, client: make(chan net.Conn, 1), finished: make(chan struct{})}
	p.lastPong.Store(time.Now().UnixNano())
	h := r.hostFor(id, true)
	if evicted := h.park(p, r.limits.ParkedPerHost); evicted != nil {
		evicted.discard()
	}
	r.log.Info("machine attached", "host", id, "from", req.RemoteAddr)
	go r.watchParked(h, p)
	go r.heartbeat(p)
}

func (r *Relay) watchParked(h *host, p *parked) {
	defer close(p.finished)
	for {
		signal, err := p.reader.ReadByte()
		if err == nil && signal == signalPing {
			p.lastPong.Store(time.Now().UnixNano())
			continue
		}
		if !p.release() {
			h.remove(p)
			p.conn.Close()
			return
		}
		client := <-p.client
		if err != nil || signal != signalOpen {
			client.Close()
			p.conn.Close()
			return
		}
		r.copyHalf(client, p.conn, p.reader)
		return
	}
}

func (p *parked) release() (claimed bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.claimed {
		p.dead = true
	}
	return p.claimed
}

func (r *Relay) heartbeat(p *parked) {
	ticker := time.NewTicker(r.limits.PingEvery)
	defer ticker.Stop()
	for range ticker.C {
		p.mu.Lock()
		if p.claimed || p.dead {
			p.mu.Unlock()
			return
		}
		silent := time.Since(time.Unix(0, p.lastPong.Load())) > r.limits.DeadAfter
		if silent {
			p.dead = true
		} else {
			p.conn.Write([]byte{signalPing})
		}
		p.mu.Unlock()
		if silent {
			p.conn.Close()
			return
		}
	}
}

func (p *parked) claim() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.dead {
		return false
	}
	p.claimed = true
	return true
}

func (p *parked) discard() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.claimed {
		p.dead = true
		p.conn.Close()
	}
}

func (h *host) park(p *parked, limit int) (evicted *parked) {
	h.mu.Lock()
	if len(h.idle) >= limit {
		evicted = h.idle[0]
		h.idle = h.idle[1:]
	}
	h.idle = append(h.idle, p)
	h.mu.Unlock()
	h.signal()
	return evicted
}

func (h *host) remove(p *parked) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.idle = slices.DeleteFunc(h.idle, func(other *parked) bool { return other == p })
}

func (h *host) signal() {
	select {
	case h.arrived <- struct{}{}:
	default:
	}
}

func (h *host) pop() *parked {
	h.mu.Lock()
	defer h.mu.Unlock()
	for len(h.idle) > 0 {
		newest := h.idle[len(h.idle)-1]
		h.idle = h.idle[:len(h.idle)-1]
		if newest.claim() {
			if len(h.idle) > 0 {
				h.signal()
			}
			return newest
		}
	}
	return nil
}

func (h *host) take(wait time.Duration) *parked {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		if p := h.pop(); p != nil {
			return p
		}
		select {
		case <-h.arrived:
		case <-timer.C:
			return nil
		}
	}
}

func (r *Relay) connectClient(w http.ResponseWriter, req *http.Request, id string) {
	if !strings.EqualFold(req.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "expected a WebSocket upgrade", http.StatusUpgradeRequired)
		return
	}
	h := r.hostFor(id, false)
	if h == nil {
		http.NotFound(w, req)
		return
	}
	if h.active.Add(1) > int32(r.limits.ActivePerHost) {
		h.active.Add(-1)
		http.Error(w, "too many sessions", http.StatusServiceUnavailable)
		return
	}
	defer h.active.Add(-1)
	client, clientReader, err := hijack(w)
	if err != nil {
		return
	}
	machine := h.take(r.limits.WaitForMachine)
	if machine == nil {
		io.WriteString(client, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
		client.Close()
		return
	}
	machine.client <- client
	r.log.Info("session opened", "host", id, "from", req.RemoteAddr)
	if _, err := machine.conn.Write(openingBytes(req, clientReader)); err != nil {
		client.Close()
		machine.conn.Close()
		<-machine.finished
		return
	}
	r.copyHalf(machine.conn, client, nil)
	<-machine.finished
	client.Close()
	machine.conn.Close()
}

func openingBytes(req *http.Request, buffered *bufio.Reader) []byte {
	var out bytes.Buffer
	out.WriteByte(signalOpen)
	out.WriteString("GET /remote HTTP/1.1\r\nHost: ")
	out.WriteString(req.Host)
	out.WriteString("\r\n")
	req.Header.WriteSubset(&out, map[string]bool{"X-Forwarded-For": true})
	out.WriteString("\r\n")
	if pending := buffered.Buffered(); pending > 0 {
		chunk, _ := buffered.Peek(pending)
		out.Write(chunk)
	}
	return out.Bytes()
}

type closeWriter interface{ CloseWrite() error }

func (r *Relay) copyHalf(dst, src net.Conn, buffered *bufio.Reader) {
	if buffered != nil {
		if pending := buffered.Buffered(); pending > 0 {
			chunk, _ := buffered.Peek(pending)
			if _, err := dst.Write(chunk); err != nil {
				src.Close()
				return
			}
		}
	}
	buffer := r.buffers.Get().(*[]byte)
	_, err := io.CopyBuffer(dst, src, *buffer)
	r.buffers.Put(buffer)
	if err != nil && !errors.Is(err, net.ErrClosed) {
		dst.Close()
		src.Close()
		return
	}
	if half, ok := dst.(closeWriter); ok {
		half.CloseWrite()
	} else {
		dst.Close()
	}
}

func hijack(w http.ResponseWriter) (net.Conn, *bufio.Reader, error) {
	conn, buffered, err := http.NewResponseController(w).Hijack()
	if err != nil {
		return nil, nil, err
	}
	conn.SetDeadline(time.Time{})
	return conn, buffered.Reader, nil
}

func headerHasToken(header http.Header, name, token string) bool {
	for _, value := range header.Values(name) {
		for part := range strings.SplitSeq(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}
