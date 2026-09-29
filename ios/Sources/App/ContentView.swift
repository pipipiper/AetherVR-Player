import SwiftUI

struct ContentView: View {
    @State private var tab: AppTab = .sources

    var body: some View {
        ZStack(alignment: .bottom) {
            // 四个页签用 ZStack 保活，切换不丢滚动位置/状态
            Group {
                SourcesView()
                    .opacity(tab == .sources ? 1 : 0)
                    .disabled(tab != .sources)
                PlaylistView()
                    .opacity(tab == .playlist ? 1 : 0)
                    .disabled(tab != .playlist)
                HistoryView()
                    .opacity(tab == .history ? 1 : 0)
                    .disabled(tab != .history)
                SettingsView()
                    .opacity(tab == .settings ? 1 : 0)
                    .disabled(tab != .settings)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // 自绘底部栏（不用系统 TabView——它的液态玻璃胶囊会投系统阴影，无法关闭）
            HStack(spacing: 0) {
                tabButton(.sources, title: "片源", icon: "play.rectangle.on.rectangle")
                tabButton(.playlist, title: "播放列表", icon: "list.bullet.rectangle")
                tabButton(.history, title: "播放记录", icon: "clock")
                tabButton(.settings, title: "设置", icon: "gearshape")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.bar)
        }
    }

    private func tabButton(_ target: AppTab, title: String, icon: String) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) { tab = target }
        } label: {
            VStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.body)
                Text(title)
                    .font(.caption2)
            }
            .foregroundStyle(tab == target ? Color.accentColor : .primary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        }
    }
}

private enum AppTab {
    case sources, playlist, history, settings
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
