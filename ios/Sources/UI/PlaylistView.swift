import SwiftUI

/// 播放列表页：页签（收藏夹 → 临时列表 → 真实列表）+ 条目列表
struct PlaylistView: View {
    @EnvironmentObject private var store: PlaylistStore
    @State private var selectedTabID: UUID?
    @State private var showNewListAlert = false
    @State private var newListName = ""
    @State private var showImportPicker = false
    @State private var exportText: String?
    @State private var errorMessage: String?
    @State private var playback: URLPlaySheet.PlaybackTarget?

    private var currentTab: Playlist? {
        let tabs = store.tabs
        return tabs.first { $0.id == selectedTabID } ?? tabs.first
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                tabBar
                if let playlist = currentTab {
                    itemList(playlist)
                }
            }
            .navigationTitle("播放列表")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("新建列表") { showNewListAlert = true }
                        Button("导入 DPL 文件") { showImportPicker = true }
                        if let playlist = currentTab, playlist.fileURL != nil {
                            Button("导出当前列表") { export(playlist) }
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .alert("新建播放列表", isPresented: $showNewListAlert) {
                TextField("列表名称", text: $newListName)
                Button("创建") {
                    do {
                        let playlist = try store.createList(name: newListName)
                        selectedTabID = playlist.id
                        newListName = ""
                    } catch {
                        errorMessage = error.localizedDescription
                    }
                }
                Button("取消", role: .cancel) { newListName = "" }
            }
            .fileImporter(isPresented: $showImportPicker, allowedContentTypes: [.plainText, .data]) { result in
                if case .success(let url) = result {
                    importDPL(url)
                }
            }
            .alert("导出 DPL", isPresented: .constant(exportText != nil)) {
                Button("拷贝到剪贴板") {
                    if let exportText { UIPasteboard.general.string = exportText }
                    exportText = nil
                }
                Button("关闭", role: .cancel) { exportText = nil }
            } message: {
                Text("列表已生成为 DPL 文本，可拷贝后分享或保存。")
            }
            .alert("操作失败", isPresented: .constant(errorMessage != nil)) {
                Button("好") { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
            .fullScreenCover(item: $playback) { target in
                VRPlayerView(
                    url: target.url,
                    title: target.title,
                    startPosition: target.position,
                    mode: VRDisplayMode(rawValue: UserDefaults.standard.string(forKey: SettingsKeys.defaultProjection) ?? "") ?? .vr360,
                    httpHeaders: target.headers,
                    hardwareDecode: target.hardwareDecode,
                    queue: target.queue,
                    queueIndex: target.queueIndex
                )
            }
        }
        .task {
            selectedTabID = store.tabs.first?.id
        }
    }

    private var tabBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(store.tabs) { playlist in
                    Button {
                        selectedTabID = playlist.id
                    } label: {
                        Text(playlist.name)
                            .font(.subheadline)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(
                                currentTab?.id == playlist.id ? Color.accentColor : Color.secondary.opacity(0.2),
                                in: Capsule()
                            )
                            .foregroundStyle(currentTab?.id == playlist.id ? .white : .primary)
                    }
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
    }

    private func itemList(_ playlist: Playlist) -> some View {
        Group {
            if playlist.items.isEmpty {
                ContentUnavailableView("列表为空", systemImage: "list.bullet.rectangle")
            } else {
                List {
                    ForEach(playlist.items) { item in
                        Button {
                            play(item)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title.isEmpty ? item.file : item.title)
                                    .lineLimit(1)
                                Text(item.file)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        .foregroundStyle(.primary)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                playlist.items.removeAll { $0.id == item.id }
                                try? store.save(playlist)
                            } label: {
                                Label("删除", systemImage: "trash")
                            }
                            if playlist.id != store.favorites.id {
                                Button {
                                    store.favorites.items.append(item)
                                    try? store.save(store.favorites)
                                } label: {
                                    Label("收藏", systemImage: "star")
                                }
                                .tint(.yellow)
                            }
                        }
                    }
                }
            }
        }
    }

    private func play(_ item: PlaylistItem) {
        guard let url = URL(string: item.file) else {
            errorMessage = "无法识别的地址：\(item.file)"
            return
        }
        let playlist = currentTab
        playback = URLPlaySheet.PlaybackTarget(
            url: url,
            title: item.title.isEmpty ? item.file : item.title,
            mode: VRDisplayMode(rawValue: UserDefaults.standard.string(forKey: SettingsKeys.defaultProjection) ?? "") ?? .vr360,
            position: TimeInterval(item.position),
            queue: playlist?.items ?? [],
            queueIndex: playlist?.items.firstIndex(where: { $0.id == item.id }) ?? 0
        )
    }

    private func importDPL(_ url: URL) {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        do {
            let text = try String(contentsOf: url, encoding: .utf8)
            let name = url.deletingPathExtension().lastPathComponent
            let playlist = try store.importDPL(text: text, name: name)
            selectedTabID = playlist.id
        } catch {
            errorMessage = "导入失败：\(error.localizedDescription)"
        }
    }

    private func export(_ playlist: Playlist) {
        exportText = DPL.build(playlist.items.map {
            DplEntry(file: $0.file, title: $0.title, position: $0.position)
        })
    }
}
