import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            SourcesView()
                .tabItem { Label("片源", systemImage: "play.rectangle.on.rectangle") }
            PlaylistView()
                .tabItem { Label("播放列表", systemImage: "list.bullet.rectangle") }
            SettingsView()
                .tabItem { Label("设置", systemImage: "gearshape") }
        }
    }
}

private struct SourcesView: View {
    @State private var showURLSheet = false
    @State private var showSMBSheet = false
    @State private var showWebDAVSheet = false
    @State private var showFilePicker = false
    @State private var localPlayback: URLPlaySheet.PlaybackTarget?
    @State private var fileError: String?

    var body: some View {
        NavigationStack {
            List {
                Section("选择片源") {
                    SourceRow(icon: "folder.fill", title: "本地文件",
                              subtitle: "从文件 App / 相册选择视频", enabled: true) {
                        showFilePicker = true
                    }
                    SourceRow(icon: "link", title: "在线链接",
                              subtitle: "播放 http(s) 视频直链", enabled: true) {
                        showURLSheet = true
                    }
                    SourceRow(icon: "network", title: "SMB 局域网",
                              subtitle: "连接 NAS / 电脑共享", enabled: true) {
                        showSMBSheet = true
                    }
                    SourceRow(icon: "globe", title: "WebDAV",
                              subtitle: "连接 WebDAV 服务器", enabled: true) {
                        showWebDAVSheet = true
                    }
                }

                Section {
                    Text("免头显 VR/360° 视频播放器 · iOS 版 v0.1.0")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .listRowBackground(Color.clear)
                }
            }
            .navigationTitle("AetherVR Player")
            .sheet(isPresented: $showURLSheet) {
                URLPlaySheet()
            }
            .sheet(isPresented: $showSMBSheet) {
                SMBConnectSheet()
            }
            .sheet(isPresented: $showWebDAVSheet) {
                WebDAVConnectSheet()
            }
            .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.audiovisualContent]) { result in
                switch result {
                case .success(let url):
                    // 安全作用域：播放期间保持访问权，播放器关闭后释放
                    _ = url.startAccessingSecurityScopedResource()
                    localPlayback = URLPlaySheet.PlaybackTarget(
                        url: url, title: url.lastPathComponent, mode: .vr360
                    )
                case .failure(let error):
                    fileError = error.localizedDescription
                }
            }
            .fullScreenCover(item: $localPlayback, onDismiss: {
                localPlayback?.url.stopAccessingSecurityScopedResource()
                localPlayback = nil
            }) { target in
                VRPlayerView(
                    url: target.url,
                    title: target.title,
                    mode: target.mode
                )
            }
            .alert("无法打开文件", isPresented: .constant(fileError != nil)) {
                Button("好") { fileError = nil }
            } message: {
                Text(fileError ?? "")
            }
        }
    }
}

private struct SourceRow: View {
    let icon: String
    let title: String
    let subtitle: String
    var enabled: Bool
    var action: () -> Void = {}

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.title2)
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline)
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if !enabled {
                    Text("开发中")
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .foregroundStyle(enabled ? .primary : .secondary)
    }
}

#Preview {
    ContentView()
        .preferredColorScheme(.dark)
}
