import AppKit
import CryptoKit
import Foundation

private struct LauncherError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private struct PLaMoServer {
    let executable: URL
    let dataDirectory: URL
    let port: Int
    let label: String

    private var target: String { "gui/\(getuid())/\(label)" }

    private func run(_ path: String, _ arguments: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }

    var isRegistered: Bool {
        (try? run("/bin/launchctl", ["print", target])) == 0
    }

    private func isReady() async -> Bool {
        struct ModelList: Decodable {
            struct Model: Decodable { let id: String }
            let data: [Model]
        }
        let url = URL(string: "http://127.0.0.1:\(port)/v1/models")!
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1)
        guard
            let (data, response) = try? await URLSession.shared.data(for: request),
            (response as? HTTPURLResponse)?.statusCode == 200,
            let models = try? JSONDecoder().decode(ModelList.self, from: data)
        else { return false }
        return models.data.contains { $0.id == "plamo-08b" }
    }

    private func isExpectedModel(_ url: URL) throws -> Bool {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard (attributes[.size] as? NSNumber)?.int64Value == 573_126_848 else { return false }
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        var hash = SHA256()
        while let chunk = try file.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            hash.update(data: chunk)
        }
        let checksum = hash.finalize().map { String(format: "%02x", Int($0)) }.joined()
        return checksum == "70891ec70dc7ab4205745a38307867c2881b99239f20327927633abfe4bc9ec6"
    }

    private func modelFile(onDownload: () -> Void) async throws -> URL {
        let fm = FileManager.default
        try fm.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        let name = "plamo-3-translate-0.8b-Q4_K_M.gguf"
        let destination = dataDirectory.appendingPathComponent(name)
        if (try? isExpectedModel(destination)) == true { return destination }

        onDownload()
        let url = URL(string: "https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/1cf96ae02133958a20074bfdfab76517bb737d00/\(name)")!
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForResource = 1800
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        let (temporary, response) = try await session.download(from: url)
        defer { try? fm.removeItem(at: temporary) }
        guard (response as? HTTPURLResponse)?.statusCode == 200, try isExpectedModel(temporary) else {
            throw LauncherError(message: "モデルを確認できませんでした。アプリを開き直すと再試行します。")
        }
        if fm.fileExists(atPath: destination.path) {
            _ = try fm.replaceItemAt(destination, withItemAt: temporary)
        } else {
            try fm.moveItem(at: temporary, to: destination)
        }
        return destination
    }

    func start(onDownload: () -> Void) async throws {
        if await isReady() { return }
        if !isRegistered {
            let model = try await modelFile(onDownload: onDownload)
            let log = dataDirectory.appendingPathComponent("server.log").path
            let status = try run("/bin/launchctl", [
                "submit", "-l", label, "-o", log, "-e", log, "--", executable.path,
                "--model", model.path, "--host", "127.0.0.1", "--port", String(port),
                "--alias", "plamo-08b", "--n-gpu-layers", "all", "--parallel", "4",
                "--ctx-size", "8192", "--batch-size", "512", "--ubatch-size", "128",
                "--n-predict", "512", "--jinja", "--no-prefill-assistant",
                "--no-cache-prompt", "--cache-ram", "0", "--log-verbosity", "3",
            ])
            guard status == 0 else {
                throw LauncherError(message: "翻訳サーバーを起動できませんでした。")
            }
        }
        for _ in 0..<20 {
            if await isReady() { return }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw LauncherError(message: "翻訳サーバーの応答を確認できませんでした。")
    }

    func stop() throws {
        guard isRegistered else { return }
        guard try run("/bin/launchctl", ["bootout", target]) == 0 || !isRegistered else {
            throw LauncherError(message: "翻訳サーバーを停止できませんでした。")
        }
    }
}

@MainActor
private final class Launcher: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let server: PLaMoServer
    private let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 365, height: 145),
        styleMask: [.titled, .closable, .miniaturizable],
        backing: .buffered, defer: false
    )
    private let status = NSTextField(wrappingLabelWithString: "PLaMoを起動しています…")
    private lazy var quitButton = NSButton(title: "終了…", target: self, action: #selector(quit))

    init(server: PLaMoServer) {
        self.server = server
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let iconFile = Bundle.main.object(forInfoDictionaryKey: "CFBundleIconFile") as? String,
           let iconURL = Bundle.main.url(forResource: iconFile, withExtension: nil),
           let icon = NSImage(contentsOf: iconURL) {
            NSApp.applicationIconImage = icon
        }

        let mainMenu = NSMenu()
        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu()
        applicationMenu.addItem(withTitle: "PLaMoを起動を終了", action: #selector(quit), keyEquivalent: "q").target = self
        mainMenu.addItem(applicationItem)
        applicationItem.submenu = applicationMenu
        NSApp.mainMenu = mainMenu

        window.title = "PLaMo 翻訳サーバー"
        window.delegate = self
        window.isReleasedWhenClosed = false
        let content = NSStackView(views: [status, quitButton])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 16
        content.translatesAutoresizingMaskIntoConstraints = false
        let view = window.contentView!
        view.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            content.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            content.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        window.center()
        window.makeKeyAndOrderFront(nil)
        Task {
            do {
                try await server.start {
                    self.status.stringValue = "翻訳モデルを取得しています（初回のみ・約547 MiB）…"
                }
                status.stringValue = "翻訳サーバーが起動しています。"
            } catch {
                status.stringValue = error.localizedDescription
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return false
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        quit()
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard server.isRegistered else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = "PLaMoも停止しますか？"
        alert.informativeText = "停止すると、このMacの翻訳サーバーで実行中の処理が中断されます。"
        alert.addButton(withTitle: "キャンセル").keyEquivalent = "\r"
        alert.addButton(withTitle: "起動したまま閉じる").keyEquivalent = ""
        alert.addButton(withTitle: "停止して終了").keyEquivalent = ""
        switch alert.runModal() {
        case .alertSecondButtonReturn:
            return .terminateNow
        case .alertThirdButtonReturn:
            do {
                try server.stop()
                return .terminateNow
            } catch {
                status.stringValue = error.localizedDescription
                return .terminateCancel
            }
        default:
            return .terminateCancel
        }
    }
}

@main
private enum Main {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let launcher = Launcher(server: PLaMoServer(
            executable: Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/llama/llama-server"),
            dataDirectory: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/PLaMo Local"),
            port: 18080, label: "local.plamo.translate"
        ))
        app.setActivationPolicy(.regular)
        app.delegate = launcher
        withExtendedLifetime(launcher) { app.run() }
    }
}
