package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"strings"
	"testing"
)

func TestSupervisedProviderAgentRequiresEphemeralLiteralLoopback(t *testing.T) {
	for _, allowed := range []string{"127.0.0.1:0", "[::1]:0"} {
		if normalized, err := supervisedLoopbackAgentAddress(allowed); err != nil || normalized != allowed {
			t.Fatalf("expected %s to be allowed, got %q: %v", allowed, normalized, err)
		}
	}
	for _, denied := range []string{
		"127.0.0.1:1460", "[::1]:1460", "localhost:0", "0.0.0.0:0", "192.168.1.10:0", ":0",
	} {
		if _, err := supervisedLoopbackAgentAddress(denied); err == nil {
			t.Fatalf("expected %s to be denied", denied)
		}
	}
}

func TestStandaloneProviderAgentKeepsPackagedPort(t *testing.T) {
	for _, allowed := range []string{"127.0.0.1:1460", "[::1]:1460"} {
		if normalized, err := loopbackAgentAddress(allowed); err != nil || normalized != allowed {
			t.Fatalf("expected %s to remain compatible, got %q: %v", allowed, normalized, err)
		}
	}
	if _, err := loopbackAgentAddress("127.0.0.1:0"); err == nil {
		t.Fatal("standalone mode must not silently switch to an undiscoverable ephemeral port")
	}
}

func TestProviderAgentBootstrapDescriptorIsFixedAndExplicit(t *testing.T) {
	if file, err := inheritedProviderAgentBootstrap(""); err != nil || file != nil {
		t.Fatalf("empty bootstrap configuration must preserve standalone mode: %#v %v", file, err)
	}
	for _, denied := range []string{"0", "1", "2", "4", "not-a-fd"} {
		if file, err := inheritedProviderAgentBootstrap(denied); err == nil || file != nil {
			t.Fatalf("unexpected bootstrap descriptor acceptance for %q", denied)
		}
	}
}

func TestProviderAgentBindsBeforeAnnouncingEphemeralAddress(t *testing.T) {
	var frame bytes.Buffer
	listener, err := openProviderAgentListener("127.0.0.1:0", nopWriteCloser{Writer: &frame})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	var announcement providerAgentBootstrapAnnouncement
	decoder := json.NewDecoder(&frame)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&announcement); err != nil {
		t.Fatal(err)
	}
	if announcement.ProtocolVersion != providerAgentBootstrapProtocol {
		t.Fatalf("unexpected bootstrap protocol: %q", announcement.ProtocolVersion)
	}
	canonical, err := boundLoopbackAgentAddress(announcement.Address)
	if err != nil || canonical != listener.Addr().String() {
		t.Fatalf("announcement does not identify the owned listener: %q != %q: %v", canonical, listener.Addr(), err)
	}

	probe, err := net.Dial("tcp", announcement.Address)
	if err != nil {
		t.Fatalf("announced address was not already bound: %v", err)
	}
	_ = probe.Close()
	if strings.Contains(frame.String(), "token") || strings.Contains(frame.String(), "Bearer") {
		t.Fatalf("bootstrap frame must contain only public listener metadata: %q", frame.String())
	}
}

func TestProviderAgentBootstrapRejectsNonLoopbackAnnouncement(t *testing.T) {
	var frame bytes.Buffer
	err := writeProviderAgentBootstrap(&frame, staticAddress("0.0.0.0:12345"))
	if err == nil || frame.Len() != 0 {
		t.Fatalf("non-loopback address was announced: %q, %v", frame.String(), err)
	}
	for _, denied := range []string{
		"127.0.0.1:0", "127.0.0.1:1460", "127.0.0.1:00080", "127.0.0.1:65536", "localhost:12345", "[::1]:0",
	} {
		if _, err := boundLoopbackAgentAddress(denied); err == nil {
			t.Fatalf("expected bound address %q to be rejected", denied)
		}
	}
}

type nopWriteCloser struct {
	io.Writer
}

func (nopWriteCloser) Close() error { return nil }

type staticAddress string

func (address staticAddress) Network() string { return "tcp" }
func (address staticAddress) String() string  { return string(address) }
