//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var menuApplicationVersion = "dev"

const (
	actionHostExited = 100
	actionStartHost  = 9
)

type menuClient struct {
	baseURL    *url.URL
	httpClient *http.Client
	adminToken string
}

type menuApplication struct {
	client                  *menuClient
	ui                      *windowsMenu
	state                   menuState
	actions                 chan int
	enrollmentDecisions     chan bool
	stop                    chan struct{}
	done                    chan struct{}
	startAttempt            bool
	ownedHost               *exec.Cmd
	pendingEnrollmentToken  string
	pendingEnrollmentAccept bool
}

func main() {
	if len(os.Args) == 2 && isVersionArgument(os.Args[1]) {
		fmt.Fprintln(os.Stdout, menuApplicationVersion)
		return
	}
	if len(os.Args) > 2 {
		fmt.Fprintln(os.Stderr, "usage: multivibe-host-menu [version|multivibe://add-worker#enrollment_token=...]")
		os.Exit(2)
	}

	pendingToken := ""
	invalidEnrollmentLink := false
	if len(os.Args) == 2 {
		pendingToken, invalidEnrollmentLink = parseEnrollmentLink(os.Args[1])
	}
	if err := runWindowsMenu(pendingToken, invalidEnrollmentLink); err != nil {
		fmt.Fprintf(os.Stderr, "multivibe-host-menu: %s\n", err)
		os.Exit(1)
	}
}

func isVersionArgument(value string) bool {
	return value == "version" || value == "--version" || value == "-version"
}

func runWindowsMenu(pendingToken string, invalidEnrollmentLink bool) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	client, err := newMenuClient()
	if err != nil {
		return err
	}
	app := &menuApplication{
		client:                  client,
		state:                   menuState{version: menuApplicationVersion, status: "Starting..."},
		actions:                 make(chan int, 16),
		enrollmentDecisions:     make(chan bool, 1),
		stop:                    make(chan struct{}),
		done:                    make(chan struct{}),
		pendingEnrollmentToken:  pendingToken,
		pendingEnrollmentAccept: false,
	}
	ui, err := newWindowsMenu(bundledIconPath(), app.actions, app.enrollmentDecisions)
	if err != nil {
		return err
	}
	app.ui = ui
	defer ui.close()

	app.publish()
	if invalidEnrollmentLink {
		showMessage("Invalid connection link", "The MultiVibe connection link is invalid or incomplete. Start again from MultiVibe Cloud.", true)
	} else if pendingToken != "" {
		ui.requestEnrollment()
	}
	go app.eventLoop()
	ui.run()
	close(app.stop)
	<-app.done
	app.stopOwnedHost()
	return nil
}

func newMenuClient() (*menuClient, error) {
	port := strings.TrimSpace(os.Getenv("MULTIVIBE_HOST_PORT"))
	if port == "" {
		port = "1455"
	}
	if parsed, err := strconv.ParseUint(port, 10, 16); err != nil || parsed == 0 || strconv.FormatUint(parsed, 10) != port {
		return nil, errors.New("MULTIVIBE_HOST_PORT must be a canonical TCP port")
	}
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) {
		return nil, errors.New("the user home directory is unavailable")
	}
	dataDirectory := strings.TrimSpace(os.Getenv("MULTIVIBE_HOST_DATA_DIR"))
	if dataDirectory == "" {
		dataHome := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
		if dataHome == "" {
			dataHome = filepath.Join(home, "AppData", "Local")
		}
		if !filepath.IsAbs(dataHome) || filepath.Clean(dataHome) != dataHome {
			return nil, errors.New("LOCALAPPDATA must be a clean absolute path")
		}
		dataDirectory = filepath.Join(dataHome, "MultiVibe")
	} else if !filepath.IsAbs(dataDirectory) || filepath.Clean(dataDirectory) != dataDirectory {
		return nil, errors.New("MULTIVIBE_HOST_DATA_DIR must be a clean absolute path")
	}
	credentialsPath := filepath.Join(dataDirectory, "host-credentials.json")
	credentialsInfo, err := os.Lstat(credentialsPath)
	if err != nil || !validMenuPrivateFile(credentialsPath, credentialsInfo) || credentialsInfo.Size() > 16*1024 {
		return nil, errors.New("the local Host credentials are unavailable")
	}
	credentialsRaw, err := os.ReadFile(credentialsPath)
	if err != nil {
		return nil, errors.New("the local Host credentials are unavailable")
	}
	var credentials hostCredentials
	if json.Unmarshal(credentialsRaw, &credentials) != nil || len(credentials.AdminToken) < 32 {
		return nil, errors.New("the local Host credentials are invalid")
	}
	baseURL, err := url.Parse("http://127.0.0.1:" + port + "/")
	if err != nil {
		return nil, errors.New("the local Host URL is invalid")
	}
	return &menuClient{
		baseURL:    baseURL,
		httpClient: &http.Client{Timeout: 3 * time.Second},
		adminToken: credentials.AdminToken,
	}, nil
}

func bundledIconPath() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	binDirectory := filepath.Dir(executable)
	if filepath.Base(binDirectory) != "bin" {
		return ""
	}
	return filepath.Join(filepath.Dir(binDirectory), "resources", "provider", "multivibe-host.ico")
}

func (client *menuClient) get(path string, destination any) error {
	return client.request(http.MethodGet, path, nil, destination)
}

func (client *menuClient) post(path string, destination any) error {
	return client.postBody(path, []byte("{}"), destination)
}

func (client *menuClient) postBody(path string, body []byte, destination any) error {
	return client.request(http.MethodPost, path, body, destination)
}

func (client *menuClient) request(method, path string, body []byte, destination any) error {
	endpoint := *client.baseURL
	parsedPath, err := url.Parse(path)
	if err != nil || parsedPath.IsAbs() || parsedPath.Host != "" {
		return errors.New("the local Host endpoint is invalid")
	}
	endpoint.Path = parsedPath.Path
	endpoint.RawQuery = parsedPath.RawQuery
	var requestBody io.Reader
	if body != nil {
		requestBody = bytes.NewReader(body)
	}
	request, err := http.NewRequest(method, endpoint.String(), requestBody)
	if err != nil {
		return errors.New("the local Host request could not be created")
	}
	request.Header.Set("x-admin-token", client.adminToken)
	request.Header.Set("accept", "application/json")
	if body != nil {
		request.Header.Set("content-type", "application/json")
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return errors.New("the local Host is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return errors.New("the local Host request was rejected")
	}
	if destination == nil {
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 2*1024*1024)).Decode(destination); err != nil {
		return errors.New("the local Host response is invalid")
	}
	return nil
}

func (app *menuApplication) eventLoop() {
	defer close(app.done)
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	app.refresh()
	for {
		select {
		case action := <-app.actions:
			switch action {
			case actionStartHost:
				app.startOwnedHost(true)
				app.refresh()
			case actionToggle, actionRefresh:
				app.refresh()
			case actionOpenDashboard:
				app.openDashboard()
			case actionCheckUpdates:
				app.updateAction("/admin/host-update/check")
			case actionInstallUpdate:
				app.updateAction("/admin/host-update/apply")
			case actionQuit:
				app.ui.stop()
			case actionStartAtLoginOn:
				if setStartAtLogin(true) == nil {
					app.ensureOwnedHost()
				}
				app.publish()
			case actionStartAtLoginOff:
				_ = setStartAtLogin(false)
				app.stopOwnedHost()
				app.publish()
			case actionHostExited:
				app.ownedHost = nil
				app.startAttempt = false
				app.refresh()
			}
		case accepted := <-app.enrollmentDecisions:
			app.pendingEnrollmentAccept = accepted
			if !accepted {
				app.pendingEnrollmentToken = ""
			} else if app.state.operational {
				app.submitPendingEnrollment()
			} else {
				app.startOwnedHost(true)
				app.refresh()
			}
		case <-ticker.C:
			app.refresh()
		case <-app.stop:
			return
		}
	}
}

func (app *menuApplication) refresh() {
	app.state.refreshing = true
	app.publish()
	var summary menuSummary
	err := app.client.get("/admin/host/menu-bar", &summary)
	if err != nil {
		app.ensureOwnedHost()
		if app.ownedHost != nil {
			time.Sleep(700 * time.Millisecond)
			err = app.client.get("/admin/host/menu-bar", &summary)
		}
	}
	if err != nil {
		app.state.operational = false
		app.state.status = "Unavailable"
	} else {
		app.state.summary = &summary
		app.state.operational = summary.Operational
		if summary.Operational {
			app.state.status = "Operational"
		} else {
			app.state.status = "Unavailable"
		}
		var update updateStatus
		if app.client.get("/admin/host-update", &update) == nil {
			app.state.update = &update
		}
		if app.state.operational && app.pendingEnrollmentAccept && app.pendingEnrollmentToken != "" {
			app.submitPendingEnrollment()
		}
	}
	app.state.refreshing = false
	app.publish()
}

func (app *menuApplication) ensureOwnedHost() {
	if !startAtLoginEnabled() {
		return
	}
	app.startOwnedHost(false)
}

func (app *menuApplication) startOwnedHost(force bool) {
	if !force && !startAtLoginEnabled() {
		return
	}
	if app.startAttempt || app.ownedHost != nil {
		return
	}
	app.startAttempt = true
	executable, err := os.Executable()
	if err != nil {
		app.startAttempt = false
		return
	}
	host := filepath.Join(filepath.Dir(executable), "multivibe-host.exe")
	info, statErr := os.Lstat(host)
	if statErr != nil || !validMenuExecutable(host, info) {
		app.startAttempt = false
		return
	}
	command := exec.Command(host, "run")
	command.Stdout = io.Discard
	command.Stderr = os.Stderr
	command.Env = os.Environ()
	if err := command.Start(); err != nil {
		app.startAttempt = false
		return
	}
	app.ownedHost = command
	go func() {
		_ = command.Wait()
		select {
		case app.actions <- actionHostExited:
		case <-app.stop:
		}
	}()
}

func (app *menuApplication) stopOwnedHost() {
	if app.ownedHost == nil || app.ownedHost.Process == nil || app.ownedHost.ProcessState != nil {
		return
	}
	_ = app.ownedHost.Process.Kill()
}

func (app *menuApplication) openDashboard() {
	if !app.state.operational {
		app.startOwnedHost(true)
		app.refresh()
	}
	if !app.state.operational {
		return
	}
	var session desktopSession
	if app.client.post("/admin/desktop-session", &session) != nil || session.Path == "" {
		return
	}
	pathURL, err := url.Parse(session.Path)
	if err != nil || pathURL.IsAbs() || pathURL.Host != "" || !strings.HasPrefix(pathURL.Path, "/") {
		return
	}
	target := app.client.baseURL.ResolveReference(pathURL)
	_ = openWindowsURL(target.String())
}

func (app *menuApplication) updateAction(path string) {
	if app.state.updateBusy {
		return
	}
	app.state.updateBusy = true
	app.publish()
	if app.client.post(path, nil) == nil {
		var update updateStatus
		if app.client.get("/admin/host-update", &update) == nil {
			app.state.update = &update
		}
	}
	app.state.updateBusy = false
	app.publish()
}

func (app *menuApplication) submitPendingEnrollment() {
	if app.pendingEnrollmentToken == "" || !app.pendingEnrollmentAccept {
		return
	}
	body, err := json.Marshal(map[string]string{"enrollment_token": app.pendingEnrollmentToken})
	if err != nil {
		return
	}
	var result struct {
		State string `json:"state"`
	}
	connected := app.client.postBody("/admin/provider-agent/cloud-shadow/enroll-handoff", body, &result) == nil && result.State == "submitted"
	app.pendingEnrollmentToken = ""
	app.pendingEnrollmentAccept = false
	if connected {
		showMessage("This Windows host is connected", "Its public identity and selected local model were registered securely.", false)
	} else {
		showMessage("This Windows host could not be connected", "Make sure one local model is selected in MultiVibe Host, then try again from MultiVibe Cloud.", true)
	}
}

func (app *menuApplication) publish() {
	if app.ui != nil {
		app.ui.setModel(serializeMenuModel(app.state))
	}
}

func showMessage(title, message string, warning bool) {
	if activeWindowsMenu != nil {
		activeWindowsMenu.showMessage(title, message, warning)
	}
}
