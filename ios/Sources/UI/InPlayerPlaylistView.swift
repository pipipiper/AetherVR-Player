import SwiftUI

/// 播放器内的播放列表弹层：页签（收藏夹 → 临时列表 → 真实列表），
/// 左右滑动切换，支持新建/导入/导出，点条目立即起播。
struct InPlayerPlaylistView: View {
    @EnvironmentObject private var store: PlaylistStore
    /// 当前正在播放的条目（高亮标记）
    let currentItemID: UUID?
    let onPick: (Playlist, Int) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selectedTabID: UUID?
    @State private var showNewListAlert = false
    @State private var newListName = ""
    @State private var showImportPicker = false
    @State private var errorMessage: String?
    /// 正在横向滑动切页签（此时禁用行点击，避免滑动手势误触发选中）
    @State private var isSwitchingTab = false

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
            .simultaneousGesture(
                // 内容区左右滑动切换页签（对齐 PC 端）
                DragGesture(minimumDistance: 20)
                    .onChanged { value in
                        let dx = value.translation.width
                        let dy = value.translation.height
                        if abs(dx) > 24, abs(dx) > abs(dy) * 1.5 {
                            isSwitchingTab = true
                        }
                    }
                    .onEnded { value in
                        // 延迟恢复行点击，防止同一次抬手触发选中
                        defer {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                                isSwitchingTab = false
                            }
                        }
                        guard isSwitchingTab else { return }
                        moveTab(value.translation.width < 0 ? 1 : -1)
                    }
            )
            .navigationTitle("播放列表")
            .navigationBarTitleDisplayMode(.inline)
            // sheet 里导航条不要渲染成不透明色块
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("关闭") { dismiss() }
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
            .alert("操作失败", isPresented: .constant(errorMessage != nil)) {
                Button("好") { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
            .alert("导出成功", isPresented: $showCopiedHint) {
                Button("好") {}
            } message: {
                Text("列表已生成为 DPL 文本并拷贝到剪贴板，可粘贴分享或保存。")
            }
        }
        .task {
            // 默认选中包含当前播放条目的列表
            if let currentItemID,
               let owner = store.tabs.first(where: { $0.items.contains { $0.id == currentItemID } }) {
                selectedTabID = owner.id
            } else {
                selectedTabID = store.tabs.first?.id
            }
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
                            Button {
                                selectedTabID = playlist.id
                            } label: {
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

    private func moveTab(_ offset: Int, proxy: ScrollViewProxy? = nil) {
        let tabs = store.tabs
        guard !tabs.isEmpty else { return }
        let current = tabs.firstIndex { $0.id == currentTab?.id } ?? 0
        let next = min(max(current + offset, 0), tabs.count - 1)
        guard next != current else { return }
        selectedTabID = tabs[next].id
        if let proxy {
            withAnimation { proxy.scrollTo(tabs[next].id, anchor: .center) }
        }
    }

    private func itemList(_ playlist: Playlist) -> some View {
        Group {
            if playlist.items.isEmpty {
                ContentUnavailableView("列表为空", systemImage: "list.bullet.rectangle")
            } else {
                List(Array(playlist.items.enumerated()), id: \.element.id) { index, item in
                    Button {
                        onPick(playlist, index)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title.isEmpty ? item.file : item.title)
                                    .lineLimit(1)
                                    .foregroundStyle(item.id == currentItemID ? Color.accentColor : .primary)
                                if item.position > 0 {
                                    Text("看到 \(formatTimeShort(item.position))")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if item.id == currentItemID {
                                Image(systemName: "play.fill")
                                    .foregroundStyle(.tint)
                                    .font(.caption)
                            }
                        }
                    }
                    .disabled(isSwitchingTab)
                }
            }
        }
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
        let text = DPL.build(playlist.items.map {
            DplEntry(file: $0.file, title: $0.title, position: $0.position)
        })
        UIPasteboard.general.string = text
        showCopiedHint = true
    }

    @State private var showCopiedHint = false

    private func formatTimeShort(_ seconds: Int) -> String {
        let m = seconds / 60
        let s = seconds % 60
        return String(format: "%d:%02d", m, s)
    }
}
