import SwiftUI

/// 播放列表页：页签（收藏夹 → 临时列表 → 真实列表）+ 原生分页切换。
/// 内容区是系统分页 TabView：左右滑翻页时行点击由系统自动取消，不会误触。
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
                // 系统分页：左右滑动切换列表（原生手势，滑动中行点击自动失效）
                TabView(selection: $selectedTabID) {
                    ForEach(store.tabs) { playlist in
                        itemList(playlist)
                            .tag(playlist.id as UUID?)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
            }
            // 页签条和底部与其它页面统一用分组背景色（否则露出两条白底）
            .background(Color(.systemGroupedBackground).ignoresSafeArea())
            .navigationTitle("播放列表")
            // 只在这个页面：分页 TabView 的内容始终在底部栏下方，触发底部栏的
            // 滚动边缘阴影。其它页面是 List/Form，没有这个问题。
            .toolbarBackground(.hidden, for: .tabBar)
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
        ScrollViewReader { proxy in
            HStack(spacing: 6) {
                Button { moveTab(-1, proxy: proxy) } label: {
                    Image(systemName: "chevron.left")
                        .font(.callout)
                        .frame(width: 28, height: 32)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(store.tabs) { playlist in
                            Text(playlist.name)
                                .font(.subheadline)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(
                                    currentTab?.id == playlist.id
                                        ? Color.accentColor.opacity(0.3)
                                        : Color.secondary.opacity(0.15),
                                    in: Capsule()
                                )
                                .foregroundStyle(currentTab?.id == playlist.id ? Color.accentColor : .primary)
                                .onTapGesture {
                                    selectedTabID = playlist.id
                                }
                                .id(playlist.id)
                        }
                    }
                    .padding(.vertical, 8)
                }
                Button { moveTab(1, proxy: proxy) } label: {
                    Image(systemName: "chevron.right")
                        .font(.callout)
                        .frame(width: 28, height: 32)
                }
                Divider().frame(height: 20)
                // 新增 / 导入 / 导出（对齐 PC 端页签条操作）
                Button { showNewListAlert = true } label: {
                    Image(systemName: "plus")
                        .font(.callout)
                        .frame(width: 28, height: 32)
                }
                Button { showImportPicker = true } label: {
                    Image(systemName: "square.and.arrow.down")
                        .font(.callout)
                        .frame(width: 28, height: 32)
                }
                if let playlist = currentTab, playlist.fileURL != nil {
                    Button { export(playlist) } label: {
                        Image(systemName: "square.and.arrow.up")
                            .font(.callout)
                            .frame(width: 28, height: 32)
                    }
                }
            }
            .padding(.horizontal, 8)
        }
    }

    /// 左移/右移页签（箭头点击或页签条上滑动），并把目标页签滚到可见位置
    private func moveTab(_ offset: Int, proxy: ScrollViewProxy? = nil) {
        let tabs = store.tabs
        guard !tabs.isEmpty else { return }
        let current = tabs.firstIndex { $0.id == currentTab?.id } ?? 0
        let next = min(max(current + offset, 0), tabs.count - 1)
        guard next != current else { return }
        withAnimation {
            selectedTabID = tabs[next].id
        }
        if let proxy {
            withAnimation { proxy.scrollTo(tabs[next].id, anchor: .center) }
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
                            play(item, in: playlist)
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
                        // 长按菜单代替左滑（分页翻页会吃掉行的左滑手势）
                        .contextMenu {
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
                            }
                        }
                    }
                }
            }
        }
    }

    private func play(_ item: PlaylistItem, in playlist: Playlist) {
        // 本地路径条目（多为电脑端导出的 dpl）：手机上看不到就明确报错
        if !item.isRemote {
            let path = item.file.replacingOccurrences(of: "file://", with: "")
            guard FileManager.default.fileExists(atPath: path) else {
                errorMessage = "文件不存在：\(item.file)\n（如果列表是从电脑端导出的，这些路径只在电脑上有效）"
                return
            }
        }
        guard let url = item.isRemote ? (URLLiteral.http(item.file) ?? URL(string: item.file)) : URL(fileURLWithPath: item.file) else {
            errorMessage = "无法识别的地址：\(item.file)"
            return
        }
        playback = URLPlaySheet.PlaybackTarget(
            url: url,
            title: item.title.isEmpty ? item.file : item.title,
            mode: VRDisplayMode(rawValue: UserDefaults.standard.string(forKey: SettingsKeys.defaultProjection) ?? "") ?? .vr360,
            position: TimeInterval(item.position),
            queue: playlist.items,
            queueIndex: playlist.items.firstIndex(where: { $0.id == item.id }) ?? 0
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
