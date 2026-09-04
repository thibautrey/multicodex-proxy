//go:build linux && cgo

package main

/*
#cgo pkg-config: gtk+-3.0
#include <stdlib.h>
#include "menu.h"
*/
import "C"

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
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var menuApplicationVersion = "dev"

func startAtLoginPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "multivibe", "start-at-login")
}
func startAtLoginEnabled() bool {
	data, err := os.ReadFile(startAtLoginPath())
	return err != nil || strings.TrimSpace(string(data)) != "0"
}
func setStartAtLogin(enabled bool) {
	path := startAtLoginPath()
	_ = os.MkdirAll(filepath.Dir(path), 0700)
	value := "0\n"
	if enabled {
		value = "1\n"
	}
	_ = os.WriteFile(path, []byte(value), 0600)
	if enabled {
		_ = exec.Command("systemctl", "--user", "enable", "--now", "multivibe-host.service").Run()
	} else {
		_ = exec.Command("systemctl", "--user", "disable", "--now", "multivibe-host.service").Run()
	}
}

const actionHostExited = 100

type menuClient struct {
	baseURL    *url.URL
	httpClient *http.Client
	adminToken string
}

type menuApplication struct {
	client                  *menuClient
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

var (
	actionSinkMu     sync.RWMutex
	actionSink       chan int
	enrollmentSinkMu sync.RWMutex
	enrollmentSink   chan bool
)

//export goMenuAction
func goMenuAction(action C.int) {
	actionSinkMu.RLock()
	sink := actionSink
	actionSinkMu.RUnlock()
	if sink == nil {
		return
	}
	select {
	case sink <- int(action):
	default:
	}
}

//export goEnrollmentDecision
func goEnrollmentDecision(accepted C.int) {
	enrollmentSinkMu.RLock()
	sink := enrollmentSink
	enrollmentSinkMu.RUnlock()
	if sink == nil {
		return
	}
	select {
	case sink <- accepted != 0:
	default:
	}
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
	if err := runLinuxMenu(pendingToken, invalidEnrollmentLink); err != nil {
		fmt.Fprintf(os.Stderr, "multivibe-host-menu: %s\n", err)
		os.Exit(1)
	}
}

func isVersionArgument(value string) bool {
	return value == "version" || value == "--version" || value == "-version"
}

func runLinuxMenu(pendingToken string, invalidEnrollmentLink bool) error {
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		return nil
	}
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

	iconPath := bundledIconPath()
	cIconPath := C.CString(iconPath)
	initialized := C.multivibe_menu_init(cIconPath) != 0
	C.free(unsafe.Pointer(cIconPath))
	if !initialized {
		return errors.New("GTK could not initialize a graphical session")
	}

	actionSinkMu.Lock()
	actionSink = app.actions
	actionSinkMu.Unlock()
	defer func() {
		actionSinkMu.Lock()
		actionSink = nil
		actionSinkMu.Unlock()
	}()
	enrollmentSinkMu.Lock()
	enrollmentSink = app.enrollmentDecisions
	enrollmentSinkMu.Unlock()
	defer func() {
		enrollmentSinkMu.Lock()
		enrollmentSink = nil
		enrollmentSinkMu.Unlock()
	}()

	app.publish()
	if invalidEnrollmentLink {
		showMessage("Invalid connection link", "The MultiVibe connection link is invalid or incomplete. Start again from MultiVibe Cloud.", true)
	} else if pendingToken != "" {
		C.multivibe_menu_request_enrollment()
	}
	go app.eventLoop()
	C.multivibe_menu_run()
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
		dataHome := strings.TrimSpace(os.Getenv("XDG_DATA_HOME"))
		if dataHome == "" {
			dataHome = filepath.Join(home, ".local", "share")
		}
		if !filepath.IsAbs(dataHome) || filepath.Clean(dataHome) != dataHome {
			return nil, errors.New("XDG_DATA_HOME must be a clean absolute path")
		}
		dataDirectory = filepath.Join(dataHome, "multivibe")
	} else if !filepath.IsAbs(dataDirectory) || filepath.Clean(dataDirectory) != dataDirectory {
		return nil, errors.New("MULTIVIBE_HOST_DATA_DIR must be a clean absolute path")
	}
	credentialsPath := filepath.Join(dataDirectory, "host-credentials.json")
	credentialsInfo, err := os.Lstat(credentialsPath)
	if err != nil || !credentialsInfo.Mode().IsRegular() || credentialsInfo.Mode()&os.ModeSymlink != 0 || credentialsInfo.Mode().Perm() != 0o600 {
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
	return filepath.Join(filepath.Dir(binDirectory), "resources", "provider", "multivibe-host.png")
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
			case int(C.MULTIVIBE_MENU_ACTION_TOGGLE), int(C.MULTIVIBE_MENU_ACTION_REFRESH):
				app.refresh()
			case int(C.MULTIVIBE_MENU_ACTION_OPEN_DASHBOARD):
				app.openDashboard()
			case int(C.MULTIVIBE_MENU_ACTION_CHECK_UPDATES):
				app.updateAction("/admin/host-update/check")
			case int(C.MULTIVIBE_MENU_ACTION_INSTALL_UPDATE):
				app.updateAction("/admin/host-update/apply")
			case int(C.MULTIVIBE_MENU_ACTION_QUIT):
				C.multivibe_menu_stop()
			case int(C.MULTIVIBE_MENU_ACTION_START_AT_LOGIN_ON):
				setStartAtLogin(true)
				app.ensureOwnedHost()
				app.publish()
			case int(C.MULTIVIBE_MENU_ACTION_START_AT_LOGIN_OFF):
				setStartAtLogin(false)
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
				app.ensureOwnedHost()
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
	if app.startAttempt || app.ownedHost != nil {
		return
	}
	app.startAttempt = true
	executable, err := os.Executable()
	if err != nil {
		app.startAttempt = false
		return
	}
	host := filepath.Join(filepath.Dir(executable), "multivibe-host")
	info, statErr := os.Lstat(host)
	if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o111 == 0 {
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
	_ = app.ownedHost.Process.Signal(syscall.SIGTERM)
}

func (app *menuApplication) openDashboard() {
	if !app.state.operational {
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
	_ = exec.Command("xdg-open", target.String()).Start()
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
		showMessage("This Linux host is connected", "Its public identity and selected local model were registered securely.", false)
	} else {
		showMessage("This Linux host could not be connected", "Make sure one local model is selected in MultiVibe Host, then try again from MultiVibe Cloud.", true)
	}
}

func (app *menuApplication) publish() {
	model := serializeMenuModel(app.state)
	cModel := C.CString(model)
	C.multivibe_menu_set_model(cModel)
	C.free(unsafe.Pointer(cModel))
}

func showMessage(title, message string, warning bool) {
	cTitle := C.CString(title)
	cMessage := C.CString(message)
	C.multivibe_menu_show_message(cTitle, cMessage, C.int(boolToInt(warning)))
	C.free(unsafe.Pointer(cTitle))
	C.free(unsafe.Pointer(cMessage))
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
