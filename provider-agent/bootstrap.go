package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
)

const (
	providerAgentBootstrapEnvironment = "MULTIVIBE_PROVIDER_BOOTSTRAP_FD"
	providerAgentBootstrapFD          = 3
	providerAgentBootstrapProtocol    = "provider-agent-bootstrap-v1"
)

type providerAgentBootstrapAnnouncement struct {
	ProtocolVersion string `json:"protocol_version"`
	Address         string `json:"address"`
}

func supervisedLoopbackAgentAddress(raw string) (string, error) {
	host, port, err := net.SplitHostPort(raw)
	if err != nil || (host != "127.0.0.1" && host != "::1") || port != "0" {
		return "", errors.New("supervised provider agent listen address must use literal loopback port 0")
	}
	return net.JoinHostPort(host, port), nil
}

func boundLoopbackAgentAddress(raw string) (string, error) {
	host, port, err := net.SplitHostPort(raw)
	if err != nil || (host != "127.0.0.1" && host != "::1") {
		return "", errors.New("provider agent bound address must use literal loopback")
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 || portNumber == 1460 || strconv.Itoa(portNumber) != port {
		return "", errors.New("provider agent bound address must use a canonical ephemeral port")
	}
	return net.JoinHostPort(host, port), nil
}

func inheritedProviderAgentBootstrap(raw string) (*os.File, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return nil, nil
	}
	if value != strconv.Itoa(providerAgentBootstrapFD) {
		return nil, errors.New("provider agent bootstrap descriptor is invalid")
	}
	file := os.NewFile(uintptr(providerAgentBootstrapFD), "provider-agent-bootstrap")
	if file == nil {
		return nil, errors.New("provider agent bootstrap descriptor is unavailable")
	}
	return file, nil
}

func openProviderAgentListener(listenAddress string, bootstrap io.WriteCloser) (net.Listener, error) {
	listener, err := net.Listen("tcp", listenAddress)
	if err != nil {
		if bootstrap != nil {
			_ = bootstrap.Close()
		}
		return nil, err
	}
	if bootstrap == nil {
		return listener, nil
	}

	announcementErr := writeProviderAgentBootstrap(bootstrap, listener.Addr())
	closeErr := bootstrap.Close()
	if announcementErr != nil || closeErr != nil {
		_ = listener.Close()
		if announcementErr != nil {
			return nil, announcementErr
		}
		return nil, fmt.Errorf("close provider agent bootstrap descriptor: %w", closeErr)
	}
	return listener, nil
}

func writeProviderAgentBootstrap(writer io.Writer, address net.Addr) error {
	canonicalAddress, err := boundLoopbackAgentAddress(address.String())
	if err != nil {
		return err
	}
	announcement := providerAgentBootstrapAnnouncement{
		ProtocolVersion: providerAgentBootstrapProtocol,
		Address:         canonicalAddress,
	}
	if err := json.NewEncoder(writer).Encode(announcement); err != nil {
		return fmt.Errorf("write provider agent bootstrap announcement: %w", err)
	}
	return nil
}
