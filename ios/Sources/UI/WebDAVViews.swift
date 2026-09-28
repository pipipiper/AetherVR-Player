import SwiftUI

/// WebDAV 服务器连接表单
struct WebDAVConnectSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var username = ""
    @State private var password = ""
    @State private var errorMessage: String?
    @State private var connecting = false
    @State private var connectedClient: WebDAVClient?

    var body: some View {
        NavigationStack {
            Form {
                Section("服务器地址") {
                    TextField("如 https://nas.example.com:5006/dav", text: $address)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
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
            .navigationTitle("连接 WebDAV")
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
                            .disabled(baseURL == nil)
                    }
                }
            }
            .navigationDestination(item: $connectedClient) { client in
                WebDAVDirectoryView(client: client, path: "/")
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var baseURL: URL? {
        let text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme), url.host != nil else {
            return nil
        }
        return url
    }

    private func connect() {
        guard let url = baseURL else { return }
        connecting = true
        errorMessage = nil
        let client = WebDAVClient(
            baseURL: url,
            username: username.isEmpty ? nil : username,
            password: password.isEmpty ? nil : password
        )
        Task {
            do {
                _ = try await client.list(path: "/")
                await MainActor.run {
                    connecting = false
                    connectedClient = client
                }
            } catch {
                await MainActor.run {
                    connecting = false
                    errorMessage = "连接失败：\(error.localizedDescription)"
                }
            }
        }
    }
}

extension WebDAVClient: Identifiable, Hashable {
    var id: ObjectIdentifier { ObjectIdentifier(self) }

    static func == (lhs: WebDAVClient, rhs: WebDAVClient) -> Bool {
        lhs === rhs
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(ObjectIdentifier(self))
    }
}

/// WebDAV 目录浏览
struct WebDAVDirectoryView: View {
    let client: WebDAVClient
    let path: String

    @State private var items: [WebDAVItem]?
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
                    List(items, id: \.path) { item in
                        if item.isDirectory {
                            NavigationLink {
                                WebDAVDirectoryView(client: client, path: item.path)
                            } label: {
                                Label(item.name, systemImage: "folder.fill")
                            }
                        } else {
                            Button {
                                play(item)
                            } label: {
                                Label {
                                    HStack {
                                        Text(item.name).lineLimit(2)
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
        .navigationTitle(path == "/" ? client.baseURL.host ?? "WebDAV" : (path as NSString).lastPathComponent)
        .task { await load() }
        .fullScreenCover(item: $playback) { target in
            VRPlayerView(
                url: target.url,
                title: target.title,
                mode: target.mode,
                httpHeaders: client.authorizationHeader
            )
        }
    }

    private static func isVideo(_ name: String) -> Bool {
        videoExtensions.contains((name as NSString).pathExtension.lowercased())
    }

    private func play(_ item: WebDAVItem) {
        guard let url = client.fileURL(path: item.path) else { return }
        playback = URLPlaySheet.PlaybackTarget(
            url: url, title: item.name, mode: .vr360
        )
    }

    private func load() async {
        do {
            items = try await client.list(path: path)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func formatSize(_ size: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
    }
}
