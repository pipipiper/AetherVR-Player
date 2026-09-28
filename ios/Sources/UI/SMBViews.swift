import SwiftUI

/// SMB 服务器连接表单
struct SMBConnectSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var host = ""
    @State private var port = "445"
    @State private var username = ""
    @State private var password = ""
    @State private var errorMessage: String?
    @State private var connecting = false
    @State private var shares: [String]?

    var body: some View {
        NavigationStack {
            Form {
                Section("服务器") {
                    TextField("主机名或 IP，如 192.168.1.10", text: $host)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("端口（默认 445）", text: $port)
                        .keyboardType(.numberPad)
                }
                Section("账号（可留空匿名）") {
                    TextField("用户名", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("密码", text: $password)
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }
                }
            }
            .navigationTitle("连接 SMB 服务器")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if connecting {
                        ProgressView()
                    } else {
                        Button("连接") { connect() }
                            .disabled(host.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .navigationDestination(item: $shares) { shareList in
                SharePickerView(config: makeConfig(), shares: shareList)
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func makeConfig() -> SMBServerConfig {
        SMBServerConfig(
            host: host.trimmingCharacters(in: .whitespaces),
            port: Int(port) ?? 445,
            share: "",
            username: username.trimmingCharacters(in: .whitespaces),
            password: password
        )
    }

    private func connect() {
        connecting = true
        errorMessage = nil
        let config = makeConfig()
        Task {
            do {
                let result = try await SMBClient(config: config).listShares()
                await MainActor.run {
                    connecting = false
                    shares = result
                }
            } catch {
                await MainActor.run {
                    connecting = false
                    self.errorMessage = "连接失败：\(error.localizedDescription)"
                }
            }
        }
    }
}

/// 选择共享 → 进入目录浏览
struct SharePickerView: View {
    let config: SMBServerConfig
    let shares: [String]

    var body: some View {
        List(shares, id: \.self) { share in
            NavigationLink {
                SMBDirectoryView(config: {
                    var c = config
                    c.share = share
                    return c
                }(), path: "/")
            } label: {
                Label(share, systemImage: "externaldrive.fill")
            }
        }
        .navigationTitle("选择共享")
    }
}

/// SMB 目录浏览
struct SMBDirectoryView: View {
    let config: SMBServerConfig
    let path: String

    @State private var items: [SMBItem]?
    @State private var errorMessage: String?
    @State private var playback: URLPlaySheet.PlaybackTarget?

    private static let videoExtensions: Set<String> = [
        "mp4", "mkv", "avi", "mov", "m4v", "ts", "flv", "wmv", "webm", "mpg", "mpeg", "rmvb", "iso",
    ]

    var body: some View {
        Group {
            if let items {
                if items.isEmpty {
                    ContentUnavailableView("空目录", systemImage: "folder")
                } else {
                    List(items) { item in
                        if item.isDirectory {
                            NavigationLink {
                                SMBDirectoryView(config: config, path: item.path)
                            } label: {
                                Label(item.name, systemImage: "folder.fill")
                            }
                        } else {
                            Button {
                                play(item)
                            } label: {
                                Label {
                                    HStack {
                                        Text(item.name)
                                            .lineLimit(2)
                                        Spacer()
                                        Text(formatSize(item.size))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                } icon: {
                                    Image(systemName: "play.rectangle.fill")
                                }
                            }
                            .foregroundStyle(.primary)
                            .disabled(!Self.isVideo(item.name))
                            .opacity(Self.isVideo(item.name) ? 1 : 0.4)
                        }
                    }
                }
            } else if let errorMessage {
                ContentUnavailableView {
                    Label("加载失败", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(errorMessage)
                }
            } else {
                ProgressView("读取目录…")
            }
        }
        .navigationTitle(path == "/" ? config.share : (path as NSString).lastPathComponent)
        .task { await load() }
        .fullScreenCover(item: $playback) { target in
            VRPlayerView(
                url: target.url,
                title: target.title,
                mode: target.mode
            )
        }
    }

    private static func isVideo(_ name: String) -> Bool {
        videoExtensions.contains((name as NSString).pathExtension.lowercased())
    }

    private func play(_ item: SMBItem) {
        guard let url = SMBClient(config: config).playURL(path: item.path) else { return }
        playback = URLPlaySheet.PlaybackTarget(
            url: url, title: item.name, mode: .vr360
        )
    }

    private func load() async {
        do {
            items = try await SMBClient(config: config).list(path: path)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func formatSize(_ size: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
    }
}
