package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

var hostApplicationVersion = "dev"

type bundleLayout struct {
	Root               string
	Node               string
	Edge               string
	Agent              string
	Updater            string
	App                string
	Security           string
	BundledOllama      string
	ModelCatalog       string
	DependencyManifest string
}

type localCredentials struct {
	SchemaVersion string `json:"schema_version"`
	AdminToken    string `json:"admin_token"`
	ProxyAPIKey   string `json:"proxy_api_key"`
}

type coreNetworkConfiguration struct {
	BindAddress   string
	Port          string
	PublicBaseURL string
}

func main() {
	if len(os.Args) != 2 {
		fatal("usage: multivibe-host <doctor|init|run|version>")
	}
	switch os.Args[1] {
	case "version", "--version", "-version":
		fmt.Fprintln(os.Stdout, hostApplicationVersion)
	case "doctor":
		if err := doctor(os.Stdout); err != nil {
			fatal(err.Error())
		}
	case "init":
		path, err := initializeState()
		if err != nil {
			fatal(err.Error())
		}
		fmt.Fprintf(os.Stdout, "MultiVibe Host state initialized at %s\n", path)
	case "run":
		if err := run(); err != nil {
			fatal(err.Error())
		}
	default:
		fatal("unknown MultiVibe Host command")
	}
}

func fatal(message string) {
	fmt.Fprintf(os.Stderr, "multivibe-host: %s\n", message)
	os.Exit(2)
}

func executableLayout(executable, goos string) (bundleLayout, error) {
	executable, err := filepath.Abs(executable)
	if err != nil || filepath.Clean(executable) != executable {
		return bundleLayout{}, errors.New("the application path is invalid")
	}
	if goos == "darwin" {
		macOSDirectory := filepath.Dir(executable)
		contents := filepath.Dir(macOSDirectory)
		if filepath.Base(macOSDirectory) != "MacOS" || filepath.Base(contents) != "Contents" {
			return bundleLayout{}, errors.New("the macOS application layout is invalid")
		}
		return bundleLayout{
			Root:               filepath.Dir(contents),
			Node:               filepath.Join(contents, "Frameworks", "node"),
			Edge:               filepath.Join(contents, "Helpers", "multivibe-v1-edge"),
			Agent:              filepath.Join(contents, "Helpers", "multivibe-provider-agent"),
			Updater:            filepath.Join(contents, "Helpers", "multivibe-host-updater"),
			App:                filepath.Join(contents, "Resources", "app"),
			Security:           filepath.Join(contents, "Resources", "app", "modules", "security"),
			BundledOllama:      filepath.Join(contents, "Resources", "ollama-runtime"),
			ModelCatalog:       filepath.Join(contents, "Resources", "provider", "provider-model-catalog.json"),
			DependencyManifest: filepath.Join(contents, "Resources", "provider", "provider-host-dependencies.json"),
		}, nil
	}
	if goos != "linux" {
		return bundleLayout{}, errors.New("the operating system is unsupported")
	}
	bin := filepath.Dir(executable)
	root := filepath.Dir(bin)
	if filepath.Base(bin) != "bin" {
		return bundleLayout{}, errors.New("the Linux application layout is invalid")
	}
	return bundleLayout{
		Root:               root,
		Node:               filepath.Join(bin, "node"),
		Agent:              filepath.Join(bin, "multivibe-provider-agent"),
		Updater:            filepath.Join(bin, "multivibe-host-updater"),
		App:                filepath.Join(root, "app"),
		Security:           filepath.Join(root, "app", "modules", "security"),
		BundledOllama:      filepath.Join(root, "runtime", "ollama"),
		ModelCatalog:       filepath.Join(root, "resources", "provider", "provider-model-catalog.json"),
		DependencyManifest: filepath.Join(root, "resources", "provider", "provider-host-dependencies.json"),
	}, nil
}

func currentLayout() (bundleLayout, error) {
	executable, err := os.Executable()
	if err != nil {
		return bundleLayout{}, errors.New("the application path is unavailable")
	}
	return executableLayout(executable, runtime.GOOS)
}

func requireRegular(path string, executable bool) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("required bundle file is unavailable: %s", filepath.Base(path))
	}
	if executable && info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("required bundle file is not executable: %s", filepath.Base(path))
	}
	return nil
}

func validateLayout(layout bundleLayout) error {
	for _, candidate := range []struct {
		path       string
		executable bool
	}{
		{layout.Node, true},
		{layout.Agent, true},
		{layout.Updater, true},
		{filepath.Join(layout.App, "dist", "server.js"), false},
		{filepath.Join(layout.App, "dist", "instrument.js"), false},
		{filepath.Join(layout.App, "package.json"), false},
		{layout.ModelCatalog, false},
		{layout.DependencyManifest, false},
	} {
		if err := requireRegular(candidate.path, candidate.executable); err != nil {
			return err
		}
	}
	if runtime.GOOS == "darwin" {
		if err := requireRegular(layout.Edge, true); err != nil {
			return err
		}
	}
	security, err := os.Lstat(layout.Security)
	if err != nil || !security.IsDir() || security.Mode()&os.ModeSymlink != 0 {
		return errors.New("the bundled security module is unavailable")
	}
	ollama, err := os.Lstat(layout.BundledOllama)
	if err != nil || !ollama.IsDir() || ollama.Mode()&os.ModeSymlink != 0 {
		return errors.New("the bundled Ollama runtime is unavailable")
	}
	return nil
}

func doctor(output io.Writer) error {
	layout, err := currentLayout()
	if err != nil {
		return err
	}
	if err := validateLayout(layout); err != nil {
		return err
	}
	command := exec.Command(layout.Agent, "doctor")
	command.Stderr = os.Stderr
	raw, err := command.Output()
	if err != nil {
		return errors.New("the host hardware is unsupported or unavailable")
	}
	var platform map[string]any
	if len(raw) > 64*1024 || json.Unmarshal(raw, &platform) != nil || platform["supported"] != true {
		return errors.New("the provider-agent hardware result is invalid")
	}
	return json.NewEncoder(output).Encode(map[string]any{
		"schema_version": "multivibe-host-doctor-v1",
		"version":        hostApplicationVersion,
		"bundle":         "valid",
		"platform":       platform,
	})
}

func defaultDataDirectory(goos string, home string, xdg string) (string, error) {
	if home == "" || !filepath.IsAbs(home) {
		return "", errors.New("the user home directory is unavailable")
	}
	if goos == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "MultiVibe"), nil
	}
	if goos != "linux" {
		return "", errors.New("the operating system is unsupported")
	}
	if xdg != "" {
		if !filepath.IsAbs(xdg) || filepath.Clean(xdg) != xdg {
			return "", errors.New("XDG_DATA_HOME must be a clean absolute path")
		}
		return filepath.Join(xdg, "multivibe"), nil
	}
	return filepath.Join(home, ".local", "share", "multivibe"), nil
}

func dataDirectory() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("MULTIVIBE_HOST_DATA_DIR")); configured != "" {
		if !filepath.IsAbs(configured) || filepath.Clean(configured) != configured {
			return "", errors.New("MULTIVIBE_HOST_DATA_DIR must be a clean absolute path")
		}
		return configured, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.New("the user home directory is unavailable")
	}
	return defaultDataDirectory(runtime.GOOS, home, os.Getenv("XDG_DATA_HOME"))
}

func randomCredential() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("secure credential generation failed")
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func credentialPath(dataDirectory string) string {
	return filepath.Join(dataDirectory, "host-credentials.json")
}

func validateCredentials(credentials localCredentials) error {
	if credentials.SchemaVersion != "multivibe-host-credentials-v1" || len(credentials.AdminToken) < 32 || len(credentials.ProxyAPIKey) < 32 {
		return errors.New("the local credential file is invalid")
	}
	return nil
}

func loadOrCreateCredentials(dataDirectory string) (localCredentials, error) {
	if err := os.MkdirAll(dataDirectory, 0o700); err != nil {
		return localCredentials{}, errors.New("the application data directory cannot be created")
	}
	if err := os.Chmod(dataDirectory, 0o700); err != nil {
		return localCredentials{}, errors.New("the application data directory cannot be protected")
	}
	path := credentialPath(dataDirectory)
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || info.Size() > 16*1024 {
			return localCredentials{}, errors.New("the local credential file permissions are invalid")
		}
		file, err := os.Open(path)
		if err != nil {
			return localCredentials{}, errors.New("the local credential file cannot be opened")
		}
		defer file.Close()
		var credentials localCredentials
		decoder := json.NewDecoder(io.LimitReader(file, 16*1024+1))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&credentials) != nil || validateCredentials(credentials) != nil {
			return localCredentials{}, errors.New("the local credential file is invalid")
		}
		var trailing any
		if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			return localCredentials{}, errors.New("the local credential file is invalid")
		}
		return credentials, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return localCredentials{}, errors.New("the local credential destination cannot be inspected")
	}
	adminToken, err := randomCredential()
	if err != nil {
		return localCredentials{}, err
	}
	proxyAPIKey, err := randomCredential()
	if err != nil {
		return localCredentials{}, err
	}
	credentials := localCredentials{
		SchemaVersion: "multivibe-host-credentials-v1",
		AdminToken:    adminToken,
		ProxyAPIKey:   proxyAPIKey,
	}
	encoded, err := json.Marshal(credentials)
	if err != nil {
		return localCredentials{}, errors.New("the local credential file cannot be encoded")
	}
	temporary, err := os.OpenFile(path+".new", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return localCredentials{}, errors.New("the local credential file cannot be staged")
	}
	removeTemporary := true
	defer func() {
		if removeTemporary {
			_ = os.Remove(path + ".new")
		}
	}()
	if _, err := temporary.Write(append(encoded, '\n')); err != nil || temporary.Sync() != nil || temporary.Close() != nil {
		_ = temporary.Close()
		return localCredentials{}, errors.New("the local credential file cannot be committed")
	}
	if err := os.Rename(path+".new", path); err != nil {
		return localCredentials{}, errors.New("the local credential file cannot be committed")
	}
	removeTemporary = false
	return credentials, nil
}

func initializeState() (string, error) {
	directory, err := dataDirectory()
	if err != nil {
		return "", err
	}
	if _, err := loadOrCreateCredentials(directory); err != nil {
		return "", err
	}
	return directory, nil
}

func inheritedEnvironment(name string) string {
	value := os.Getenv(name)
	if strings.IndexByte(value, 0) >= 0 {
		return ""
	}
	return value
}

func hostPort(value string) (string, error) {
	if value == "" {
		return "1455", nil
	}
	port, err := strconv.ParseUint(value, 10, 16)
	if err != nil || port == 0 || strconv.FormatUint(port, 10) != value {
		return "", errors.New("MULTIVIBE_HOST_PORT must be a canonical TCP port")
	}
	return value, nil
}

func hostBindAddress(value string) (string, error) {
	if value == "" {
		return strings.Join([]string{"127", "0", "0", "1"}, "."), nil
	}
	for _, allowed := range []string{"127.0.0.1", "::1", "0.0.0.0", "::"} {
		if value == allowed {
			return value, nil
		}
	}
	return "", errors.New("MULTIVIBE_HOST_BIND must be a literal loopback or wildcard address")
}

func loopbackOrigin(bindAddress, port string) string {
	if bindAddress == "::1" {
		return "http://[::1]:" + port
	}
	return "http://127.0.0.1:" + port
}

func hostPublicBaseURL(value, bindAddress, port string) (string, error) {
	if value == "" {
		if bindAddress == "127.0.0.1" || bindAddress == "::1" {
			return loopbackOrigin(bindAddress, port), nil
		}
		return "", errors.New("MULTIVIBE_HOST_PUBLIC_URL is required when the Host binds outside loopback")
	}
	if strings.TrimSpace(value) != value || strings.IndexByte(value, 0) >= 0 {
		return "", errors.New("MULTIVIBE_HOST_PUBLIC_URL must be a clean HTTP(S) origin")
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" ||
		parsed.User != nil || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawPath != "" || strings.Contains(parsed.Host, "%") {
		return "", errors.New("MULTIVIBE_HOST_PUBLIC_URL must be a clean HTTP(S) origin")
	}
	if parsed.Hostname() == "" || strings.ContainsAny(parsed.Hostname(), "[]") {
		return "", errors.New("MULTIVIBE_HOST_PUBLIC_URL must be a clean HTTP(S) origin")
	}
	publicPort := parsed.Port()
	if publicPort != "" {
		if _, err := hostPort(publicPort); err != nil {
			return "", errors.New("MULTIVIBE_HOST_PUBLIC_URL must use a canonical TCP port")
		}
	}
	canonicalAuthority := parsed.Hostname()
	if strings.Contains(canonicalAuthority, ":") {
		canonicalAuthority = "[" + canonicalAuthority + "]"
	}
	if publicPort != "" {
		canonicalAuthority = net.JoinHostPort(parsed.Hostname(), publicPort)
	}
	if parsed.Host != canonicalAuthority {
		return "", errors.New("MULTIVIBE_HOST_PUBLIC_URL must use a canonical authority")
	}
	return strings.TrimSuffix(value, "/"), nil
}

func managedDirectory(dataDirectory string) (string, error) {
	configured := strings.TrimSpace(os.Getenv("MULTIVIBE_HOST_MANAGED_DIR"))
	if configured == "" {
		return filepath.Join(dataDirectory, "provider-agent-managed"), nil
	}
	if !filepath.IsAbs(configured) || filepath.Clean(configured) != configured || configured == string(filepath.Separator) {
		return "", errors.New("MULTIVIBE_HOST_MANAGED_DIR must be a clean absolute non-root path")
	}
	return configured, nil
}

func coreEnvironment(layout bundleLayout, dataDirectory, managedDirectory string, credentials localCredentials, network coreNetworkConfiguration) []string {
	nodeHost, nodePort := network.BindAddress, network.Port
	if runtime.GOOS == "darwin" {
		nodeHost, nodePort = "127.0.0.1", "1456"
	}
	environment := []string{
		"NODE_ENV=production",
		"APP_VERSION=" + hostApplicationVersion,
		"HOST=" + nodeHost,
		"PORT=" + nodePort,
		"PUBLIC_BASE_URL=" + network.PublicBaseURL,
		"OAUTH_REDIRECT_URI=" + network.PublicBaseURL + "/auth/callback",
		"ADMIN_TOKEN=" + credentials.AdminToken,
		"PROXY_API_KEY=" + credentials.ProxyAPIKey,
		"STORE_PATH=" + filepath.Join(dataDirectory, "accounts.json"),
		"MODULES_PATH=" + filepath.Join(dataDirectory, "modules"),
		"BUNDLED_SECURITY_MODULE_PATH=" + layout.Security,
		"OAUTH_STATE_PATH=" + filepath.Join(dataDirectory, "oauth-state.json"),
		"TRACE_FILE_PATH=" + filepath.Join(dataDirectory, "requests-trace.jsonl"),
		"TRACE_STATS_HISTORY_PATH=" + filepath.Join(dataDirectory, "requests-stats-history.jsonl"),
		"ANONYMOUS_USAGE_STATE_PATH=" + filepath.Join(dataDirectory, "anonymous-usage-state.json"),
		"CODEX_PROJECTS_PATH=" + filepath.Join(dataDirectory, "codex-projects.json"),
		"JOBS_DB_PATH=" + filepath.Join(dataDirectory, "jobs.sqlite"),
		"PROVIDER_AGENT_ENABLED=true",
		"MULTIVIBE_HOST_APPLICATION=true",
		"PROVIDER_AGENT_BINARY=" + layout.Agent,
		"PROVIDER_AGENT_STATE_PATH=" + filepath.Join(dataDirectory, "provider-agent-selection.json"),
		"PROVIDER_AGENT_RUNTIME_STATE_PATH=" + filepath.Join(dataDirectory, "provider-agent-runtime-endpoints.json"),
		"PROVIDER_AGENT_DEVICE_KEY_PATH=" + filepath.Join(dataDirectory, "provider-agent-device-identity.json"),
		"PROVIDER_AGENT_ENROLLMENT_STATE_PATH=" + filepath.Join(dataDirectory, "provider-agent-cloud-enrollment.json"),
		"PROVIDER_AGENT_CAPACITY_POLICY_PATH=" + filepath.Join(dataDirectory, "provider-agent-capacity-policy.json"),
		"PROVIDER_AGENT_MANAGED_ROOT=" + managedDirectory,
		"PROVIDER_AGENT_BUNDLED_OLLAMA_ROOT=" + layout.BundledOllama,
		"PROVIDER_AGENT_DEPENDENCY_MANIFEST_PATH=" + layout.DependencyManifest,
		"PROVIDER_AGENT_MANAGED_PLANNER_STATE_PATH=" + filepath.Join(dataDirectory, "provider-agent-managed-planner-state.json"),
		"PROVIDER_AGENT_MODEL_CATALOG_PATH=" + layout.ModelCatalog,
		"PROVIDER_AGENT_CLOUD_API_URL=https://auth.multivibe.cloud",
		"TRACE_INCLUDE_BODY=false",
		"TRACE_INCLUDE_HEADERS=false",
		"PATH=/usr/bin:/bin:/usr/sbin:/sbin",
	}
	if runtime.GOOS == "darwin" {
		environment = append(environment, "CONTROL_PLANE_PORT=1456", "MULTIVIBE_CONTROL_PLANE=true")
	}
	if inheritedEnvironment("MULTIVIBE_HOST_CONTAINER") != "true" {
		environment = append(environment, "MULTIVIBE_HOST_UPDATER_BINARY="+layout.Updater)
	}
	for _, name := range []string{"HOME", "LANG", "LC_ALL", "SSL_CERT_DIR", "SSL_CERT_FILE", "TMPDIR", "TZ"} {
		if value := inheritedEnvironment(name); value != "" {
			environment = append(environment, name+"="+value)
		}
	}
	if trustedKeys := inheritedEnvironment("MULTIVIBE_PROVIDER_DEMAND_TRUSTED_KEYS"); trustedKeys != "" {
		environment = append(environment, "PROVIDER_AGENT_DEMAND_TRUSTED_KEYS="+trustedKeys)
	}
	for _, pair := range []struct {
		source      string
		destination string
	}{
		{"MULTIVIBE_PROVIDER_OLLAMA_LISTEN", "PROVIDER_AGENT_OLLAMA_LISTEN"},
		{"MULTIVIBE_PROVIDER_CUDA_VISIBLE_DEVICES", "PROVIDER_AGENT_CUDA_VISIBLE_DEVICES"},
	} {
		if value := inheritedEnvironment(pair.source); value != "" {
			environment = append(environment, pair.destination+"="+value)
		}
	}
	return environment
}

func edgeEnvironment(base []string, network coreNetworkConfiguration, internalToken string) []string {
	environment := append([]string{}, base...)
	environment = append(environment,
		"V1_EDGE_HOST="+network.BindAddress,
		"V1_EDGE_PORT="+network.Port,
		"V1_EDGE_BASE_URL="+network.PublicBaseURL,
		"NODE_CONTROL_PLANE_URL=http://127.0.0.1:1456",
		"V1_EDGE_INTERNAL_JOB_TOKEN="+internalToken,
	)
	return environment
}

func run() error {
	layout, err := currentLayout()
	if err != nil {
		return err
	}
	if err := validateLayout(layout); err != nil {
		return err
	}
	probe := exec.Command(layout.Agent, "doctor")
	probe.Stdout = io.Discard
	probe.Stderr = os.Stderr
	if err := probe.Run(); err != nil {
		return errors.New("the host hardware is unsupported or unavailable")
	}
	data, err := dataDirectory()
	if err != nil {
		return err
	}
	credentials, err := loadOrCreateCredentials(data)
	if err != nil {
		return err
	}
	port, err := hostPort(strings.TrimSpace(os.Getenv("MULTIVIBE_HOST_PORT")))
	if err != nil {
		return err
	}
	bindAddress, err := hostBindAddress(strings.TrimSpace(os.Getenv("MULTIVIBE_HOST_BIND")))
	if err != nil {
		return err
	}
	publicBaseURL, err := hostPublicBaseURL(strings.TrimSpace(os.Getenv("MULTIVIBE_HOST_PUBLIC_URL")), bindAddress, port)
	if err != nil {
		return err
	}
	managed, err := managedDirectory(data)
	if err != nil {
		return err
	}
	entry := filepath.Join(layout.App, "dist", "server.js")
	instrument := filepath.Join(layout.App, "dist", "instrument.js")
	arguments := []string{layout.Node, "--import", instrument, entry}
	if err := os.Chdir(layout.App); err != nil {
		return errors.New("the bundled application directory is unavailable")
	}
	network := coreNetworkConfiguration{BindAddress: bindAddress, Port: port, PublicBaseURL: publicBaseURL}
	internalToken, err := randomCredential()
	if err != nil {
		return err
	}
	baseEnvironment := coreEnvironment(layout, data, managed, credentials, network)
	if runtime.GOOS != "darwin" {
		return syscall.Exec(layout.Node, arguments, baseEnvironment)
	}
	baseEnvironment = append(baseEnvironment, "V1_EDGE_INTERNAL_JOB_TOKEN="+internalToken)
	node := exec.Command(layout.Node, arguments[1:]...)
	node.Dir = layout.App
	node.Env = baseEnvironment
	node.Stdout, node.Stderr = os.Stdout, os.Stderr
	edge := exec.Command(layout.Edge)
	edge.Dir = layout.App
	edge.Env = edgeEnvironment(baseEnvironment, network, internalToken)
	edge.Stdout, edge.Stderr = os.Stdout, os.Stderr
	if err := node.Start(); err != nil {
		return errors.New("the Node control plane could not be started")
	}
	if err := edge.Start(); err != nil {
		_ = node.Process.Kill()
		_ = node.Wait()
		return errors.New("the Rust v1 edge could not be started")
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(stop)
	nodeDone := make(chan error, 1)
	edgeDone := make(chan error, 1)
	go func() { nodeDone <- node.Wait() }()
	go func() { edgeDone <- edge.Wait() }()
	select {
	case signal := <-stop:
		_ = node.Process.Signal(signal)
		_ = edge.Process.Signal(signal)
		<-nodeDone
		<-edgeDone
		return nil
	case err := <-edgeDone:
		_ = node.Process.Kill()
		<-nodeDone
		return fmt.Errorf("Rust v1 edge stopped: %w", err)
	case err := <-nodeDone:
		_ = edge.Process.Kill()
		<-edgeDone
		return fmt.Errorf("Node control plane stopped: %w", err)
	}
}
