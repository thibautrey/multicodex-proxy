import AppKit
import Foundation

private let configuredHostPort: Int = {
    let configured = ProcessInfo.processInfo.environment["MULTIVIBE_HOST_PORT"] ?? "1455"
    return Int(configured).flatMap { (1...65535).contains($0) ? $0 : nil } ?? 1455
}()

private let hasExplicitHostPort = ProcessInfo.processInfo.environment["MULTIVIBE_HOST_PORT"] != nil

private struct HostCredentials: Decodable {
    let adminToken: String

    enum CodingKeys: String, CodingKey {
        case adminToken = "admin_token"
    }
}

private struct MenuBarSummary: Decodable {
    struct Earnings: Decodable {
        let available: Bool
        let currency: String?
        let today: Decimal?
        let week: Decimal?
        let month: Decimal?
    }

    let operational: Bool
    let earnings: Earnings
}

private struct DesktopSession: Decodable {
    let path: String
}

@main
final class MultiVibeMenuBarApp: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private var refreshTimer: Timer?
    private var signalSources: [DispatchSourceSignal] = []
    private var ownedService: Process?
    private var dashboardURL = URL(string: "http://127.0.0.1:\(configuredHostPort)")!
    private var usesFallbackPort = false
    private var pendingDashboardOpen = false
    private var operational = false
    private var statusText = "Starting…"
    private var earnings: MenuBarSummary.Earnings?

    static func main() {
        let app = NSApplication.shared
        let delegate = MultiVibeMenuBarApp()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureStatusItem()
        configureTerminationSignals()
        rebuildMenu()
        ensureServiceIsRunning()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
        if let process = ownedService, process.isRunning {
            process.terminate()
        }
    }

    private func configureStatusItem() {
        guard let button = statusItem.button else { return }
        let iconURL = Bundle.main.resourceURL?.appendingPathComponent("MultiVibeMenuBarIcon.png")
        if let iconURL, let image = NSImage(contentsOf: iconURL) {
            image.size = NSSize(width: 18, height: 18)
            image.isTemplate = false
            button.image = image
        } else {
            button.image = NSImage(systemSymbolName: "waveform.path", accessibilityDescription: "MultiVibe")
        }
        button.toolTip = "MultiVibe Host"
    }

    private func configureTerminationSignals() {
        for signalNumber in [SIGINT, SIGTERM] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { NSApplication.shared.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        let title = NSMenuItem(title: "MultiVibe Host \(version)", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)

        let state = NSMenuItem(title: "Status: \(statusText)", action: nil, keyEquivalent: "")
        state.isEnabled = false
        menu.addItem(state)
        menu.addItem(.separator())

        let earningsTitle = NSMenuItem(title: "Earnings", action: nil, keyEquivalent: "")
        earningsTitle.isEnabled = false
        menu.addItem(earningsTitle)
        menu.addItem(disabledItem("Today", value: earningText(\.today)))
        menu.addItem(disabledItem("This week", value: earningText(\.week)))
        menu.addItem(disabledItem("This month", value: earningText(\.month)))
        menu.addItem(.separator())

        let dashboard = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "d")
        dashboard.target = self
        menu.addItem(dashboard)
        if !operational {
            let start = NSMenuItem(title: "Start Service", action: #selector(startService), keyEquivalent: "")
            start.target = self
            menu.addItem(start)
        }
        let refresh = NSMenuItem(title: "Refresh", action: #selector(refreshNow), keyEquivalent: "r")
        refresh.target = self
        menu.addItem(refresh)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit MultiVibe Host", action: #selector(quitApplication), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
    }

    private func disabledItem(_ label: String, value: String) -> NSMenuItem {
        let item = NSMenuItem(title: "\(label): \(value)", action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func earningText(_ keyPath: KeyPath<MenuBarSummary.Earnings, Decimal?>) -> String {
        guard let earnings, earnings.available, let value = earnings[keyPath: keyPath], let currency = earnings.currency else {
            return "Not available"
        }
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currency
        return formatter.string(from: value as NSDecimalNumber) ?? "\(value) \(currency)"
    }

    private func credentialsURL() -> URL? {
        if let configured = ProcessInfo.processInfo.environment["MULTIVIBE_HOST_DATA_DIR"], !configured.isEmpty {
            return URL(fileURLWithPath: configured, isDirectory: true).appendingPathComponent("host-credentials.json")
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/MultiVibe", isDirectory: true)
            .appendingPathComponent("host-credentials.json")
    }

    private func readCredentials() -> HostCredentials? {
        guard let url = credentialsURL(), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(HostCredentials.self, from: data)
    }

    private func authorizedRequest(path: String, method: String = "GET") -> URLRequest? {
        guard let credentials = readCredentials(), let url = URL(string: path, relativeTo: dashboardURL) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 3
        request.setValue(credentials.adminToken, forHTTPHeaderField: "x-admin-token")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        return request
    }

    private func refresh() {
        guard let request = authorizedRequest(path: "/admin/host/menu-bar") else {
            updateState(operational: false, status: "Starting…", earnings: nil)
            if ownedService?.isRunning != true {
                ensureServiceIsRunning()
            }
            return
        }
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let http = response as? HTTPURLResponse
            guard let data, http?.statusCode == 200,
                  let summary = try? JSONDecoder().decode(MenuBarSummary.self, from: data) else {
                DispatchQueue.main.async {
                    self?.updateState(operational: false, status: "Unavailable", earnings: nil)
                    if self?.ownedService?.isRunning != true {
                        self?.launchService(avoidingOccupiedPort: http != nil)
                    }
                }
                return
            }
            DispatchQueue.main.async {
                self?.updateState(
                    operational: summary.operational,
                    status: summary.operational ? "Operational" : "Unavailable",
                    earnings: summary.earnings
                )
                if summary.operational, self?.pendingDashboardOpen == true {
                    self?.requestDashboardSession()
                }
            }
        }.resume()
    }

    private func updateState(operational: Bool, status: String, earnings: MenuBarSummary.Earnings?) {
        self.operational = operational
        self.statusText = status
        self.earnings = earnings
        statusItem.button?.toolTip = "MultiVibe Host — \(status)"
        rebuildMenu()
    }

    private func ensureServiceIsRunning() {
        if ownedService?.isRunning == true {
            refresh()
            return
        }
        if let request = authorizedRequest(path: "/admin/host/menu-bar") {
            URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
                let http = response as? HTTPURLResponse
                let isOurs = http?.statusCode == 200 && data.flatMap {
                    try? JSONDecoder().decode(MenuBarSummary.self, from: $0)
                } != nil
                DispatchQueue.main.async {
                    if isOurs {
                        self?.refresh()
                    } else {
                        self?.launchService(avoidingOccupiedPort: http != nil)
                    }
                }
            }.resume()
            return
        }
        var health = URLRequest(url: dashboardURL.appendingPathComponent("health"))
        health.timeoutInterval = 1
        URLSession.shared.dataTask(with: health) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                self?.launchService(avoidingOccupiedPort: response != nil)
            }
        }.resume()
    }

    private func launchService(avoidingOccupiedPort: Bool = false) {
        if let process = ownedService, process.isRunning { return }
        if avoidingOccupiedPort && !hasExplicitHostPort && !usesFallbackPort {
            dashboardURL = URL(string: "http://127.0.0.1:1456")!
            usesFallbackPort = true
        }
        guard let executable = Bundle.main.executableURL else {
            updateState(operational: false, status: "Bundle error", earnings: nil)
            return
        }
        let command = executable.deletingLastPathComponent().appendingPathComponent("multivibe-host")
        let process = Process()
        process.executableURL = command
        process.arguments = ["run"]
        var environment = ProcessInfo.processInfo.environment
        environment["MULTIVIBE_HOST_PORT"] = String(dashboardURL.port ?? configuredHostPort)
        process.environment = environment
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.ownedService = nil
                self?.updateState(operational: false, status: "Stopped", earnings: nil)
            }
        }
        do {
            try process.run()
            ownedService = process
            updateState(operational: false, status: "Starting…", earnings: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.refresh() }
        } catch {
            updateState(operational: false, status: "Failed to start", earnings: nil)
        }
    }

    @objc private func startService() {
        ensureServiceIsRunning()
    }

    @objc private func refreshNow() {
        refresh()
    }

    @objc private func openDashboard() {
        pendingDashboardOpen = true
        if !operational {
            updateState(operational: false, status: "Starting…", earnings: nil)
            ensureServiceIsRunning()
            return
        }
        requestDashboardSession()
    }

    private func requestDashboardSession() {
        guard var request = authorizedRequest(path: "/admin/desktop-session", method: "POST") else {
            ensureServiceIsRunning()
            return
        }
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            guard let data, (response as? HTTPURLResponse)?.statusCode == 200,
                  let session = try? JSONDecoder().decode(DesktopSession.self, from: data),
                  let url = URL(string: session.path, relativeTo: self.dashboardURL) else { return }
            DispatchQueue.main.async {
                self.pendingDashboardOpen = false
                NSWorkspace.shared.open(url)
            }
        }.resume()
    }

    @objc private func quitApplication() {
        NSApplication.shared.terminate(nil)
    }
}
