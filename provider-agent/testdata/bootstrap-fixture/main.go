package main

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

const bootstrapProtocol = "provider-agent-bootstrap-v1"

type bootstrapAnnouncement struct {
	ProtocolVersion string `json:"protocol_version"`
	Address         string `json:"address"`
}

func main() {
	listenAddress := os.Getenv("MULTIVIBE_PROVIDER_AGENT_LISTEN")
	bootstrapFD := os.Getenv("MULTIVIBE_PROVIDER_BOOTSTRAP_FD")
	controlToken := os.Getenv("MULTIVIBE_PROVIDER_CONTROL_TOKEN")
	statePath := os.Getenv("MULTIVIBE_PROVIDER_STATE_PATH")
	if listenAddress != "127.0.0.1:0" || bootstrapFD != "3" || len(controlToken) < 32 || statePath == "" {
		os.Exit(2)
	}

	priorState, _ := os.ReadFile(statePath)
	priorAddresses := strings.Fields(string(priorState))
	var guard net.Listener
	if len(priorAddresses) > 0 {
		guard, _ = net.Listen("tcp", priorAddresses[len(priorAddresses)-1])
		if guard != nil {
			defer guard.Close()
		}
	}

	listener, err := net.Listen("tcp", listenAddress)
	if err != nil {
		os.Exit(2)
	}
	defer listener.Close()
	bootstrap := os.NewFile(3, "provider-agent-bootstrap")
	if bootstrap == nil {
		os.Exit(2)
	}
	if err := json.NewEncoder(bootstrap).Encode(bootstrapAnnouncement{
		ProtocolVersion: bootstrapProtocol,
		Address:         listener.Addr().String(),
	}); err != nil {
		os.Exit(2)
	}
	if err := bootstrap.Close(); err != nil {
		os.Exit(2)
	}
	state, err := os.OpenFile(statePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		os.Exit(2)
	}
	if _, err := state.WriteString(listener.Addr().String() + "\n"); err != nil {
		_ = state.Close()
		os.Exit(2)
	}
	if err := state.Close(); err != nil {
		os.Exit(2)
	}

	server := &http.Server{
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       2 * time.Second,
		WriteTimeout:      2 * time.Second,
		IdleTimeout:       2 * time.Second,
		MaxHeaderBytes:    8 * 1024,
	}
	server.Handler = http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/manifest" || request.Header.Get("authorization") != "Bearer "+controlToken {
			http.NotFound(response, request)
			return
		}
		response.Header().Set("content-type", "application/json")
		_, _ = response.Write([]byte(`{"protocol_version":"provider-agent-v1","state":"detected","selected_models":[]}`))
		if len(priorAddresses) == 0 {
			go func() {
				time.Sleep(20 * time.Millisecond)
				_ = server.Close()
			}()
		}
	})
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		os.Exit(1)
	}
}
