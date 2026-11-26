package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type result struct {
	Route        string  `json:"route"`
	ConnectP50   float64 `json:"connectP50Ms"`
	ConnectP90   float64 `json:"connectP90Ms"`
	RTTP50       float64 `json:"rttP50Ms"`
	RTTP99       float64 `json:"rttP99Ms"`
	BigEchoP50   float64 `json:"bigEchoP50Ms"`
	BigMBps      float64 `json:"bigEchoMBps"`
	ParallelMBps float64 `json:"parallelMBps"`
}

func percentile(samples []time.Duration, p float64) float64 {
	sorted := slices.Clone(samples)
	slices.Sort(sorted)
	return float64(sorted[int(float64(len(sorted)-1)*p)].Microseconds()) / 1000
}

func dial(ctx context.Context, url string, client *http.Client) (*websocket.Conn, error) {
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(64 << 20)
	return conn, nil
}

func echo(ctx context.Context, conn *websocket.Conn, payload []byte) (time.Duration, error) {
	start := time.Now()
	if err := conn.Write(ctx, websocket.MessageBinary, payload); err != nil {
		return 0, err
	}
	_, got, err := conn.Read(ctx)
	if err != nil {
		return 0, err
	}
	if len(got) != len(payload) {
		return 0, fmt.Errorf("echo returned %d bytes, sent %d", len(got), len(payload))
	}
	return time.Since(start), nil
}

func fresh(url string, ca string) *http.Client {
	transport := &http.Transport{DisableKeepAlives: true, TLSClientConfig: &tls.Config{}}
	if ca != "" {
		pem, err := os.ReadFile(ca)
		if err != nil {
			panic(err)
		}
		pool := x509.NewCertPool()
		pool.AppendCertsFromPEM(pem)
		transport.TLSClientConfig.RootCAs = pool
	}
	return &http.Client{Transport: transport}
}

func main() {
	url := flag.String("url", "", "WebSocket URL to the echo server")
	route := flag.String("route", "relay", "label for the result")
	ca := flag.String("ca", "", "CA certificate to trust")
	connects := flag.Int("connects", 30, "fresh connections to time")
	echoes := flag.Int("echoes", 500, "small echoes to time")
	bigs := flag.Int("bigs", 5, "16 MiB echoes to time")
	parallel := flag.Int("parallel", 4, "sessions streaming 16 MiB echoes at once")
	flag.Parse()
	ctx := context.Background()

	var connectTimes []time.Duration
	for range *connects {
		start := time.Now()
		conn, err := dial(ctx, *url, fresh(*url, *ca))
		if err != nil {
			panic(err)
		}
		if _, err := echo(ctx, conn, make([]byte, 64)); err != nil {
			panic(err)
		}
		connectTimes = append(connectTimes, time.Since(start))
		conn.Close(websocket.StatusNormalClosure, "")
		time.Sleep(100 * time.Millisecond)
	}

	conn, err := dial(ctx, *url, fresh(*url, *ca))
	if err != nil {
		panic(err)
	}
	small := make([]byte, 64)
	var rtts []time.Duration
	for range *echoes {
		took, err := echo(ctx, conn, small)
		if err != nil {
			panic(err)
		}
		rtts = append(rtts, took)
	}
	big := make([]byte, 16<<20)
	rand.Read(big)
	var bigTimes []time.Duration
	for range *bigs {
		took, err := echo(ctx, conn, big)
		if err != nil {
			panic(err)
		}
		bigTimes = append(bigTimes, took)
	}
	conn.Close(websocket.StatusNormalClosure, "")

	var wait sync.WaitGroup
	start := time.Now()
	for range *parallel {
		wait.Go(func() {
			conn, err := dial(ctx, *url, fresh(*url, *ca))
			if err != nil {
				panic(err)
			}
			defer conn.Close(websocket.StatusNormalClosure, "")
			for range 2 {
				if _, err := echo(ctx, conn, big); err != nil {
					panic(err)
				}
			}
		})
	}
	wait.Wait()
	parallelSeconds := time.Since(start).Seconds()

	bigP50 := percentile(bigTimes, 0.5)
	out, _ := json.Marshal(result{
		Route:        *route,
		ConnectP50:   percentile(connectTimes, 0.5),
		ConnectP90:   percentile(connectTimes, 0.9),
		RTTP50:       percentile(rtts, 0.5),
		RTTP99:       percentile(rtts, 0.99),
		BigEchoP50:   bigP50,
		BigMBps:      2 * 16 / (bigP50 / 1000),
		ParallelMBps: float64(*parallel) * 2 * 2 * 16 / parallelSeconds,
	})
	fmt.Println(string(out))
}
