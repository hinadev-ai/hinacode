package main

import (
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

const minTokenLength = 32

type config struct {
	listen  string
	cert    string
	key     string
	token   string
	verbose bool
}

func parseConfig(args []string, getenv func(string) string) (config, error) {
	flags := flag.NewFlagSet("hinacode-relayd", flag.ContinueOnError)
	c := config{}
	flags.StringVar(&c.listen, "listen", ":8443", "address to listen on")
	flags.StringVar(&c.cert, "tls-cert", "", "TLS certificate file; serve plain HTTP behind a TLS proxy when empty")
	flags.StringVar(&c.key, "tls-key", "", "TLS private key file")
	tokenFile := flags.String("token-file", "", "file holding the token machines attach with, instead of HINACODE_RELAY_TOKEN")
	flags.BoolVar(&c.verbose, "verbose", false, "log every attach and session")
	if err := flags.Parse(args); err != nil {
		return c, err
	}
	c.token = getenv("HINACODE_RELAY_TOKEN")
	if *tokenFile != "" {
		raw, err := os.ReadFile(*tokenFile)
		if err != nil {
			return c, err
		}
		c.token = strings.TrimSpace(string(raw))
	}
	if len(c.token) < minTokenLength {
		return c, fmt.Errorf("the machine token must be at least %d characters; generate one with `openssl rand -base64 32`", minTokenLength)
	}
	if (c.cert == "") != (c.key == "") {
		return c, errors.New("-tls-cert and -tls-key go together")
	}
	return c, nil
}

func newServer(c config, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              c.listen,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    8 << 10,
		TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			NextProtos: []string{"http/1.1"},
		},
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){},
	}
}

func main() {
	c, err := parseConfig(os.Args[1:], os.Getenv)
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	level := slog.LevelWarn
	if c.verbose {
		level = slog.LevelInfo
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	server := newServer(c, NewRelay(c.token, DefaultLimits, log))
	log.Warn("hinacode-relayd listening", "address", c.listen, "tls", c.cert != "")
	if c.cert != "" {
		err = server.ListenAndServeTLS(c.cert, c.key)
	} else {
		err = server.ListenAndServe()
	}
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
