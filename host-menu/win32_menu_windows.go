//go:build windows

package main

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const (
	actionToggle          = 1
	actionOpenDashboard   = 2
	actionRefresh         = 3
	actionCheckUpdates    = 4
	actionInstallUpdate   = 5
	actionQuit            = 6
	actionStartAtLoginOn  = 7
	actionStartAtLoginOff = 8

	wmClose         = 0x0010
	wmDestroy       = 0x0002
	wmCommand       = 0x0111
	wmLButtonUp     = 0x0202
	wmLButtonDblClk = 0x0203
	wmRButtonUp     = 0x0205
	wmApp           = 0x8000
	wmTray          = wmApp + 1
	wmApplyModel    = wmApp + 2
	wmShowMessage   = wmApp + 3
	wmEnrollment    = wmApp + 4
	wmStop          = wmApp + 5

	windowStyle = 0x00C80000 | 0x00080000 | 0x00020000 // WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX
	childStyle  = 0x40000000 | 0x10000000              // WS_CHILD | WS_VISIBLE
	staticStyle = childStyle
	buttonStyle = childStyle | 0x00000000 // BS_PUSHBUTTON
	editStyle   = childStyle | 0x00200000 | 0x00800000 | 0x00000004 | 0x00000040 | 0x00000800 | 0x00000100
	checkStyle  = childStyle | 0x00000003 // BS_AUTOCHECKBOX

	windowExTool       = 0x00000080 // WS_EX_TOOLWINDOW
	windowExClientEdge = 0x00000200 // WS_EX_CLIENTEDGE

	swHide = 0
	swShow = 5

	buttonPrimary = 1001
	buttonRefresh = 1002
	buttonCheck   = 1003
	buttonInstall = 1004
	buttonLogin   = 1005
	buttonQuit    = 1006

	menuOpenDashboard = 2001
	menuRefresh       = 2002
	menuCheckUpdates  = 2003
	menuInstallUpdate = 2004
	menuStartLogin    = 2005
	menuQuit          = 2006

	bnClicked = 0

	mfString    = 0x00000000
	mfSeparator = 0x00000800
	mfChecked   = 0x00000008

	tpmRightButton = 0x00000002
	tpmRetCommand  = 0x00000100

	nimAdd        = 0x00000000
	nimDelete     = 0x00000002
	nimSetVersion = 0x00000004
	nifMessage    = 0x00000001
	nifIcon       = 0x00000002
	nifTip        = 0x00000004
	notifyVersion = 4

	imageIcon      = 1
	lrLoadFromFile = 0x00000010
	lrDefaultSize  = 0x00000040
	idiApplication = 32512
	idcArrow       = 32512
	colorWindow    = 5

	mbOk              = 0x00000000
	mbYesNo           = 0x00000004
	mbIconInformation = 0x00000040
	mbIconWarning     = 0x00000030
	mbIconQuestion    = 0x00000020
	mbDefButton2      = 0x00000100
	idYes             = 6
)

type windowsPoint struct {
	X int32
	Y int32
}

type windowsMessage struct {
	HWnd    syscall.Handle
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Point   windowsPoint
	Private uint32
}

type windowsWndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   syscall.Handle
	Icon       syscall.Handle
	Cursor     syscall.Handle
	Background syscall.Handle
	MenuName   *uint16
	ClassName  *uint16
	SmallIcon  syscall.Handle
}

type windowsNotifyIconData struct {
	Size        uint32
	Wnd         syscall.Handle
	ID          uint32
	Flags       uint32
	Callback    uint32
	Icon        syscall.Handle
	Tip         [128]uint16
	State       uint32
	StateMask   uint32
	Info        [256]uint16
	Version     uint32
	InfoTitle   [64]uint16
	InfoFlags   uint32
	Guid        [16]byte
	BalloonIcon syscall.Handle
}

type windowsMessagePayload struct {
	title   string
	message string
	warning bool
}

type windowsMenu struct {
	hwnd      syscall.Handle
	instance  syscall.Handle
	icon      syscall.Handle
	tray      windowsNotifyIconData
	trayAdded bool
	actions   chan int
	decisions chan bool

	title   syscall.Handle
	status  syscall.Handle
	body    syscall.Handle
	primary syscall.Handle
	refresh syscall.Handle
	check   syscall.Handle
	install syscall.Handle
	login   syscall.Handle
	quit    syscall.Handle

	mu                sync.Mutex
	pendingModel      string
	pendingMessage    *windowsMessagePayload
	pendingEnrollment bool
	operational       bool
	updateAvailable   bool
}

var (
	user32Windows   = syscall.NewLazyDLL("user32.dll")
	shell32Windows  = syscall.NewLazyDLL("shell32.dll")
	kernel32Windows = syscall.NewLazyDLL("kernel32.dll")

	registerClassExWindows  = user32Windows.NewProc("RegisterClassExW")
	createWindowExWindows   = user32Windows.NewProc("CreateWindowExW")
	defWindowProcWindows    = user32Windows.NewProc("DefWindowProcW")
	getMessageWindows       = user32Windows.NewProc("GetMessageW")
	translateMessageWindows = user32Windows.NewProc("TranslateMessage")
	dispatchMessageWindows  = user32Windows.NewProc("DispatchMessageW")
	postMessageWindows      = user32Windows.NewProc("PostMessageW")
	destroyWindowWindows    = user32Windows.NewProc("DestroyWindow")
	postQuitMessageWindows  = user32Windows.NewProc("PostQuitMessage")
	showWindowWindows       = user32Windows.NewProc("ShowWindow")
	isWindowVisibleWindows  = user32Windows.NewProc("IsWindowVisible")
	updateWindowWindows     = user32Windows.NewProc("UpdateWindow")
	setWindowTextWindows    = user32Windows.NewProc("SetWindowTextW")
	enableWindowWindows     = user32Windows.NewProc("EnableWindow")
	sendMessageWindows      = user32Windows.NewProc("SendMessageW")
	getCursorPosWindows     = user32Windows.NewProc("GetCursorPos")
	setForegroundWindows    = user32Windows.NewProc("SetForegroundWindow")
	createPopupMenuWindows  = user32Windows.NewProc("CreatePopupMenu")
	appendMenuWindows       = user32Windows.NewProc("AppendMenuW")
	trackPopupMenuWindows   = user32Windows.NewProc("TrackPopupMenu")
	destroyMenuWindows      = user32Windows.NewProc("DestroyMenu")
	messageBoxWindows       = user32Windows.NewProc("MessageBoxW")
	loadImageWindows        = user32Windows.NewProc("LoadImageW")
	loadIconWindows         = user32Windows.NewProc("LoadIconW")
	loadCursorWindows       = user32Windows.NewProc("LoadCursorW")
	shellNotifyWindows      = shell32Windows.NewProc("Shell_NotifyIconW")
	shellExecuteWindows     = shell32Windows.NewProc("ShellExecuteW")
	getModuleHandleWindows  = kernel32Windows.NewProc("GetModuleHandleW")
)

var activeWindowsMenu *windowsMenu

func newWindowsMenu(iconPath string, actions chan int, decisions chan bool) (*windowsMenu, error) {
	instanceValue, _, _ := getModuleHandleWindows.Call(0)
	if instanceValue == 0 {
		return nil, errors.New("the Windows menu module handle is unavailable")
	}
	instance := syscall.Handle(instanceValue)
	className, err := syscall.UTF16PtrFromString("MultiVibeHostMenuWindow")
	if err != nil {
		return nil, err
	}
	icon := loadMenuIcon(iconPath)
	cursor, _, _ := loadCursorWindows.Call(0, idcArrow)
	wndClass := windowsWndClassEx{
		Size:       uint32(unsafe.Sizeof(windowsWndClassEx{})),
		WndProc:    syscall.NewCallback(windowsMenuWindowProc),
		Instance:   instance,
		Icon:       icon,
		Cursor:     syscall.Handle(cursor),
		Background: syscall.Handle(colorWindow + 1),
		ClassName:  className,
		SmallIcon:  icon,
	}
	registered, _, registerErr := registerClassExWindows.Call(uintptr(unsafe.Pointer(&wndClass)))
	if registered == 0 && registerErr != syscall.Errno(1410) { // ERROR_CLASS_ALREADY_EXISTS
		return nil, errors.New("the Windows menu window class could not be registered")
	}

	menu := &windowsMenu{instance: instance, icon: icon, actions: actions, decisions: decisions}
	activeWindowsMenu = menu
	title, _ := syscall.UTF16PtrFromString("MultiVibe Host")
	hwnd, _, _ := createWindowExWindows.Call(
		windowExTool,
		uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(title)), windowStyle,
		uintptr(int32(0)), uintptr(int32(0)), uintptr(int32(520)), uintptr(int32(640)),
		0, 0, uintptr(instance), 0,
	)
	if hwnd == 0 {
		activeWindowsMenu = nil
		return nil, errors.New("the Windows menu window could not be created")
	}
	menu.hwnd = syscall.Handle(hwnd)
	if err := menu.createControls(); err != nil {
		menu.close()
		return nil, err
	}
	if !menu.addTrayIcon() {
		menu.close()
		return nil, errors.New("the Windows notification-area icon could not be created")
	}
	return menu, nil
}

func loadMenuIcon(path string) syscall.Handle {
	if path != "" {
		widePath, err := syscall.UTF16PtrFromString(path)
		if err == nil {
			loaded, _, _ := loadImageWindows.Call(0, uintptr(unsafe.Pointer(widePath)), imageIcon, 32, 32, lrLoadFromFile|lrDefaultSize)
			if loaded != 0 {
				return syscall.Handle(loaded)
			}
		}
	}
	loaded, _, _ := loadIconWindows.Call(0, idiApplication)
	return syscall.Handle(loaded)
}

func (menu *windowsMenu) createControls() error {
	var err error
	menu.title, err = menu.createChild("STATIC", "MultiVibe Host  unknown", staticStyle, 20, 16, 470, 30, 0)
	if err != nil {
		return err
	}
	menu.status, err = menu.createChild("STATIC", "Starting...", staticStyle, 20, 48, 470, 24, 0)
	if err != nil {
		return err
	}
	menu.body, err = menu.createChild("EDIT", "", editStyle|windowExClientEdge, 20, 80, 470, 420, 0)
	if err != nil {
		return err
	}
	menu.primary, err = menu.createChild("BUTTON", "Open Dashboard", buttonStyle, 20, 515, 180, 34, buttonPrimary)
	if err != nil {
		return err
	}
	menu.refresh, err = menu.createChild("BUTTON", "Refresh", buttonStyle, 210, 515, 85, 34, buttonRefresh)
	if err != nil {
		return err
	}
	menu.check, err = menu.createChild("BUTTON", "Check Updates", buttonStyle, 305, 515, 115, 34, buttonCheck)
	if err != nil {
		return err
	}
	menu.install, err = menu.createChild("BUTTON", "Install Safely", buttonStyle, 20, 555, 180, 34, buttonInstall)
	if err != nil {
		return err
	}
	menu.login, err = menu.createChild("BUTTON", "Start MultiVibe Host when I log in", checkStyle, 210, 555, 260, 34, buttonLogin)
	if err != nil {
		return err
	}
	menu.quit, err = menu.createChild("BUTTON", "Quit", buttonStyle, 420, 515, 70, 34, buttonQuit)
	if err != nil {
		return err
	}
	showWindowWindows.Call(uintptr(menu.install), swHide)
	return nil
}

func (menu *windowsMenu) createChild(className, title string, style uint32, x, y, width, height, id int) (syscall.Handle, error) {
	class, err := syscall.UTF16PtrFromString(className)
	if err != nil {
		return 0, err
	}
	text, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return 0, err
	}
	hwnd, _, _ := createWindowExWindows.Call(
		0,
		uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(text)), uintptr(style),
		uintptr(int32(x)), uintptr(int32(y)), uintptr(int32(width)), uintptr(int32(height)),
		uintptr(menu.hwnd), uintptr(id), uintptr(menu.instance), 0,
	)
	if hwnd == 0 {
		return 0, fmt.Errorf("the Windows menu control %s could not be created", className)
	}
	return syscall.Handle(hwnd), nil
}

func (menu *windowsMenu) addTrayIcon() bool {
	menu.tray = windowsNotifyIconData{
		Size:     uint32(unsafe.Sizeof(windowsNotifyIconData{})),
		Wnd:      menu.hwnd,
		ID:       1,
		Flags:    nifMessage | nifIcon | nifTip,
		Callback: wmTray,
		Icon:     menu.icon,
	}
	tip := syscall.StringToUTF16("MultiVibe Host")
	copy(menu.tray.Tip[:], tip)
	result, _, _ := shellNotifyWindows.Call(nimAdd, uintptr(unsafe.Pointer(&menu.tray)))
	if result == 0 {
		return false
	}
	menu.trayAdded = true
	menu.tray.Version = notifyVersion
	shellNotifyWindows.Call(nimSetVersion, uintptr(unsafe.Pointer(&menu.tray)))
	return true
}

func (menu *windowsMenu) removeTrayIcon() {
	if !menu.trayAdded {
		return
	}
	shellNotifyWindows.Call(nimDelete, uintptr(unsafe.Pointer(&menu.tray)))
	menu.trayAdded = false
}

func (menu *windowsMenu) run() {
	var message windowsMessage
	for {
		result, _, _ := getMessageWindows.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			return
		}
		translateMessageWindows.Call(uintptr(unsafe.Pointer(&message)))
		dispatchMessageWindows.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func (menu *windowsMenu) close() {
	menu.removeTrayIcon()
	if menu.hwnd != 0 {
		destroyWindowWindows.Call(uintptr(menu.hwnd))
		menu.hwnd = 0
	}
	if activeWindowsMenu == menu {
		activeWindowsMenu = nil
	}
}

func (menu *windowsMenu) setModel(model string) {
	menu.mu.Lock()
	menu.pendingModel = model
	menu.mu.Unlock()
	menu.post(wmApplyModel)
}

func (menu *windowsMenu) showMessage(title, message string, warning bool) {
	menu.mu.Lock()
	menu.pendingMessage = &windowsMessagePayload{title: title, message: message, warning: warning}
	menu.mu.Unlock()
	menu.post(wmShowMessage)
}

func (menu *windowsMenu) requestEnrollment() {
	menu.mu.Lock()
	menu.pendingEnrollment = true
	menu.mu.Unlock()
	menu.post(wmEnrollment)
}

func (menu *windowsMenu) stop() {
	menu.post(wmStop)
}

func (menu *windowsMenu) post(message uint32) {
	if menu.hwnd != 0 {
		postMessageWindows.Call(uintptr(menu.hwnd), uintptr(message), 0, 0)
	}
}

func (menu *windowsMenu) emit(action int) {
	select {
	case menu.actions <- action:
	default:
	}
}

func (menu *windowsMenu) renderModel() {
	menu.mu.Lock()
	model := menu.pendingModel
	menu.mu.Unlock()
	lines := strings.Split(model, "\n")
	line := func(index int) string {
		if index < 0 || index >= len(lines) {
			return ""
		}
		return lines[index]
	}
	version := line(modelVersion)
	if version == "" {
		version = "unknown"
	}
	setWindowsText(menu.title, "MultiVibe Host  "+version)
	status := line(modelStatus)
	if status == "" {
		status = "Unavailable"
	}
	setWindowsText(menu.status, status)
	menu.operational = line(modelOperational) == "1"
	setWindowsText(menu.primary, map[bool]string{true: "Open Dashboard", false: "Start Host"}[menu.operational])
	refreshing := line(modelRefreshing) == "1"
	setWindowsText(menu.refresh, map[bool]string{true: "Refreshing...", false: "Refresh"}[refreshing])
	enableWindowWindows.Call(uintptr(menu.refresh), boolToWindowsInt(!refreshing))
	updateVersion := line(modelUpdateAvailableVersion)
	menu.updateAvailable = updateVersion != ""
	installRequested := line(modelUpdateInstallRequested) == "1"
	busy := line(modelUpdateBusy) == "1"
	if menu.updateAvailable {
		if installRequested {
			setWindowsText(menu.install, "Installation Queued")
		} else {
			setWindowsText(menu.install, "Install Safely")
		}
		enableWindowWindows.Call(uintptr(menu.install), boolToWindowsInt(!busy && !installRequested))
		showWindowWindows.Call(uintptr(menu.install), swShow)
	} else {
		showWindowWindows.Call(uintptr(menu.install), swHide)
	}
	checked := line(modelStartAtLogin) == "1"
	sendMessageWindows.Call(uintptr(menu.login), 0x00F1, boolToWindowsInt(checked), 0) // BM_SETCHECK

	setWindowsText(menu.body, menu.bodyText(lines))
}

func (menu *windowsMenu) bodyText(lines []string) string {
	line := func(index int) string {
		if index < 0 || index >= len(lines) {
			return ""
		}
		return lines[index]
	}
	var builder strings.Builder
	builder.WriteString("OPENAI CAPACITY\n")
	builder.WriteString("5 hours: ")
	if line(modelFiveHourPresent) == "1" {
		builder.WriteString(line(modelFiveHourValue))
	} else {
		builder.WriteString("—")
	}
	if line(modelFiveHourAccountCount) != "" {
		builder.WriteString(" (" + line(modelFiveHourAccountCount) + ")")
	}
	builder.WriteString("\nWeekly: ")
	if line(modelWeeklyPresent) == "1" {
		builder.WriteString(line(modelWeeklyValue))
	} else {
		builder.WriteString("—")
	}
	if line(modelWeeklyAccountCount) != "" {
		builder.WriteString(" (" + line(modelWeeklyAccountCount) + ")")
	}
	builder.WriteString("\n\nACCOUNTS\n")
	accountCount := 0
	for index := modelFirstAccount; index < len(lines); index++ {
		if !strings.HasPrefix(lines[index], "A\t") {
			continue
		}
		fields := strings.Split(lines[index], "\t")
		if len(fields) < 14 {
			continue
		}
		accountCount++
		builder.WriteString("• " + fields[1] + " — " + statusDisplay(fields[2]) + "\n")
		for _, quota := range []struct {
			name                  string
			present, value, reset int
		}{
			{"5H", 4, 5, 6}, {"WEEK", 7, 8, 9}, {"MONTH", 10, 11, 12},
		} {
			if fields[quota.present] == "1" && fields[quota.reset] != "No reset time" {
				builder.WriteString("  " + quota.name + ": " + fields[quota.value] + " — " + fields[quota.reset] + "\n")
			}
		}
		builder.WriteString("  " + fields[13] + "\n")
	}
	if accountCount == 0 {
		if menu.operational {
			builder.WriteString("No OpenAI account yet. Add an account from the dashboard.\n")
		} else {
			builder.WriteString("Host data unavailable. Start or refresh MultiVibe Host.\n")
		}
	}
	builder.WriteString("\nEARNINGS\n")
	if line(modelEarningsAvailable) == "1" {
		builder.WriteString("Today: " + line(modelEarningsToday) + "\n")
		builder.WriteString("This week: " + line(modelEarningsWeek) + "\n")
		builder.WriteString("This month: " + line(modelEarningsMonth) + "\n")
	} else {
		builder.WriteString("Not available\n")
	}
	builder.WriteString("\nHOST UPDATES\n")
	if line(modelUpdateAvailableVersion) != "" {
		builder.WriteString("Version " + line(modelUpdateAvailableVersion) + " available")
		if line(modelUpdateDownloaded) == "1" {
			builder.WriteString(" — verified download ready")
		} else {
			builder.WriteString(" — ready for verified background download")
		}
		builder.WriteString("\n")
	} else if line(modelUpdateStatus) == "current" {
		builder.WriteString("MultiVibe Host is up to date.\n")
	} else {
		builder.WriteString("Automatic verified updates.\n")
	}
	return builder.String()
}

func statusDisplay(value string) string {
	switch value {
	case "ready":
		return "Ready"
	case "paused":
		return "Paused"
	case "limited":
		return "Limited"
	default:
		return "Attention"
	}
}

func (menu *windowsMenu) toggleWindow() {
	visible, _, _ := isWindowVisibleWindows.Call(uintptr(menu.hwnd))
	if visible != 0 {
		showWindowWindows.Call(uintptr(menu.hwnd), swHide)
		return
	}
	showWindowWindows.Call(uintptr(menu.hwnd), swShow)
	updateWindowWindows.Call(uintptr(menu.hwnd))
	setForegroundWindows.Call(uintptr(menu.hwnd))
}

func (menu *windowsMenu) showContextMenu() {
	popup, _, _ := createPopupMenuWindows.Call()
	if popup == 0 {
		return
	}
	defer destroyMenuWindows.Call(popup)
	label := "Open Dashboard"
	if !menu.operational {
		label = "Start Host"
	}
	appendWindowsMenu(popup, menuOpenDashboard, label, false)
	appendWindowsMenu(popup, menuRefresh, "Refresh", false)
	appendWindowsMenu(popup, menuCheckUpdates, "Check Updates", false)
	if menu.updateAvailable {
		appendWindowsMenu(popup, menuInstallUpdate, "Install Safely", false)
	}
	appendMenuWindows.Call(popup, mfSeparator, 0, 0)
	appendWindowsMenu(popup, menuStartLogin, "Start MultiVibe Host when I log in", startAtLoginEnabled())
	appendWindowsMenu(popup, menuQuit, "Quit", false)
	var point windowsPoint
	if result, _, _ := getCursorPosWindows.Call(uintptr(unsafe.Pointer(&point))); result == 0 {
		return
	}
	setForegroundWindows.Call(uintptr(menu.hwnd))
	selected, _, _ := trackPopupMenuWindows.Call(popup, tpmRightButton|tpmRetCommand, uintptr(point.X), uintptr(point.Y), 0, uintptr(menu.hwnd), 0)
	switch selected {
	case menuOpenDashboard:
		if menu.operational {
			menu.emit(actionOpenDashboard)
		} else {
			menu.emit(actionStartHost)
		}
	case menuRefresh:
		menu.emit(actionRefresh)
	case menuCheckUpdates:
		menu.emit(actionCheckUpdates)
	case menuInstallUpdate:
		menu.emit(actionInstallUpdate)
	case menuStartLogin:
		checked, _, _ := sendMessageWindows.Call(uintptr(menu.login), 0x00F0, 0, 0) // BM_GETCHECK
		if checked == 0 {
			menu.emit(actionStartAtLoginOn)
		} else {
			menu.emit(actionStartAtLoginOff)
		}
	case menuQuit:
		menu.emit(actionQuit)
	}
	postMessageWindows.Call(uintptr(menu.hwnd), 0, 0, 0)
}

func appendWindowsMenu(menu uintptr, id int, label string, checked bool) {
	text, err := syscall.UTF16PtrFromString(label)
	if err != nil {
		return
	}
	flags := uint32(mfString)
	if checked {
		flags |= mfChecked
	}
	appendMenuWindows.Call(menu, uintptr(flags), uintptr(id), uintptr(unsafe.Pointer(text)))
}

func (menu *windowsMenu) bodyMessage() {
	menu.mu.Lock()
	payload := menu.pendingMessage
	menu.pendingMessage = nil
	menu.mu.Unlock()
	if payload == nil {
		return
	}
	caption, captionErr := syscall.UTF16PtrFromString(payload.title)
	message, messageErr := syscall.UTF16PtrFromString(payload.message)
	if captionErr != nil || messageErr != nil {
		return
	}
	flags := uint32(mbOk)
	if payload.warning {
		flags |= mbIconWarning
	} else {
		flags |= mbIconInformation
	}
	messageBoxWindows.Call(uintptr(menu.hwnd), uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(caption)), uintptr(flags))
}

func (menu *windowsMenu) enrollmentMessage() {
	menu.mu.Lock()
	pending := menu.pendingEnrollment
	menu.pendingEnrollment = false
	menu.mu.Unlock()
	if !pending {
		return
	}
	caption, _ := syscall.UTF16PtrFromString("MultiVibe Host")
	message, _ := syscall.UTF16PtrFromString("Add this Windows host to MultiVibe Cloud?\r\n\r\nMultiVibe Host will share its public device identity and selected local models. Your private key stays on this Windows host.")
	flags := uint32(mbYesNo | mbIconQuestion | mbDefButton2)
	result, _, _ := messageBoxWindows.Call(uintptr(menu.hwnd), uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(caption)), uintptr(flags))
	select {
	case menu.decisions <- result == idYes:
	default:
	}
}

func windowsMenuWindowProc(hwnd syscall.Handle, message uint32, wParam, lParam uintptr) uintptr {
	menu := activeWindowsMenu
	if menu == nil || menu.hwnd != hwnd {
		result, _, _ := defWindowProcWindows.Call(uintptr(hwnd), uintptr(message), wParam, lParam)
		return result
	}
	switch message {
	case wmApplyModel:
		menu.renderModel()
		return 0
	case wmShowMessage:
		menu.bodyMessage()
		return 0
	case wmEnrollment:
		menu.enrollmentMessage()
		return 0
	case wmStop:
		menu.removeTrayIcon()
		destroyWindowWindows.Call(uintptr(hwnd))
		return 0
	case wmTray:
		switch uint32(lParam) {
		case wmLButtonUp, wmLButtonDblClk:
			menu.toggleWindow()
			menu.emit(actionToggle)
		case wmRButtonUp:
			menu.showContextMenu()
		}
		return 0
	case wmCommand:
		if uint16(lParam>>16) != bnClicked {
			return 0
		}
		switch int(uint16(wParam)) {
		case buttonPrimary:
			if menu.operational {
				menu.emit(actionOpenDashboard)
			} else {
				menu.emit(actionStartHost)
			}
		case buttonRefresh:
			menu.emit(actionRefresh)
		case buttonCheck:
			menu.emit(actionCheckUpdates)
		case buttonInstall:
			menu.emit(actionInstallUpdate)
		case buttonLogin:
			checked, _, _ := sendMessageWindows.Call(uintptr(menu.login), 0x00F0, 0, 0)
			if checked == 0 {
				menu.emit(actionStartAtLoginOn)
			} else {
				menu.emit(actionStartAtLoginOff)
			}
		case buttonQuit:
			menu.emit(actionQuit)
		}
		return 0
	case wmClose:
		showWindowWindows.Call(uintptr(hwnd), swHide)
		return 0
	case wmDestroy:
		menu.removeTrayIcon()
		postQuitMessageWindows.Call(0)
		return 0
	}
	result, _, _ := defWindowProcWindows.Call(uintptr(hwnd), uintptr(message), wParam, lParam)
	return result
}

func setWindowsText(hwnd syscall.Handle, value string) {
	value = strings.ReplaceAll(value, "\n", "\r\n")
	text, err := syscall.UTF16PtrFromString(value)
	if err == nil {
		setWindowTextWindows.Call(uintptr(hwnd), uintptr(unsafe.Pointer(text)))
	}
}

func boolToWindowsInt(value bool) uintptr {
	if value {
		return 1
	}
	return 0
}

func openWindowsURL(raw string) error {
	verb, err := syscall.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	target, err := syscall.UTF16PtrFromString(raw)
	if err != nil {
		return err
	}
	result, _, _ := shellExecuteWindows.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(target)), 0, 0, swShow)
	if result <= 32 {
		return errors.New("Windows could not open the dashboard")
	}
	return nil
}
