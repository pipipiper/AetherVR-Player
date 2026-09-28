import Foundation

/// 播放列表条目（对应 dpl 的一条记录）
struct PlaylistItem: Equatable, Identifiable {
    var id = UUID()
    /// 本地文件路径 / http(s) 直链 / smb:// 链接
    var file: String
    var title: String
    /// 起播位置（秒）
    var position: Int = 0

    var isRemote: Bool {
        file.lowercased().hasPrefix("http://") || file.lowercased().hasPrefix("https://")
            || file.lowercased().hasPrefix("smb://")
    }
}

/// 播放列表。fileURL 为 nil 时是「临时列表」，永不落盘。
final class Playlist: ObservableObject, Identifiable {
    let id: UUID
    @Published var name: String
    @Published var items: [PlaylistItem]
    let fileURL: URL?

    init(id: UUID = UUID(), name: String, items: [PlaylistItem] = [], fileURL: URL?) {
        self.id = id
        self.name = name
        self.items = items
        self.fileURL = fileURL
    }
}

/// 播放列表仓库：收藏夹（固定首位）→ 临时列表 → 真实列表，顺序与网页版一致。
/// 真实列表和收藏夹以 .dpl 文件存于 Documents/Playlists/。
@MainActor
final class PlaylistStore: ObservableObject {
    static let favoritesName = "收藏夹"
    static let tempName = "临时列表"

    @Published private(set) var favorites: Playlist
    @Published private(set) var temp: Playlist
    @Published private(set) var userLists: [Playlist] = []

    /// 页签顺序：收藏夹 → 临时列表 → 真实列表
    var tabs: [Playlist] { [favorites, temp] + userLists }

    let directory: URL

    init(directory: URL? = nil) {
        let dir = directory
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Playlists", isDirectory: true)
        self.directory = dir
        let favsFile = dir.appendingPathComponent("\(Self.favoritesName).dpl")
        favorites = Playlist(name: Self.favoritesName, fileURL: favsFile)
        temp = Playlist(name: Self.tempName, fileURL: nil)
    }

    func load() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let files = try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension.lowercased() == "dpl" }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        var lists: [Playlist] = []
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            let entries = try DPL.parse(text)
            let name = file.deletingPathExtension().lastPathComponent
            let items = entries.map { PlaylistItem(file: $0.file, title: $0.title, position: $0.position) }
            if name == Self.favoritesName {
                favorites.items = items
            } else {
                lists.append(Playlist(name: name, items: items, fileURL: file))
            }
        }
        userLists = lists
    }

    func save(_ playlist: Playlist) throws {
        guard let fileURL = playlist.fileURL else { return } // 临时列表不落盘
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let entries = playlist.items.map {
            DplEntry(file: $0.file, title: $0.title, position: $0.position)
        }
        try DPL.build(entries).write(to: fileURL, atomically: true, encoding: .utf8)
    }

    @discardableResult
    func createList(name: String) throws -> Playlist {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalName = trimmed.isEmpty ? "播放列表 \(userLists.count + 1)" : trimmed
        let playlist = Playlist(
            name: finalName,
            fileURL: directory.appendingPathComponent("\(finalName).dpl")
        )
        userLists.append(playlist)
        try save(playlist)
        return playlist
    }

    func removeList(_ playlist: Playlist) throws {
        guard let index = userLists.firstIndex(where: { $0.id == playlist.id }) else { return }
        userLists.remove(at: index)
        if let fileURL = playlist.fileURL {
            try? FileManager.default.removeItem(at: fileURL)
        }
    }

    /// 导入 dpl 文件内容为新列表
    @discardableResult
    func importDPL(text: String, name: String) throws -> Playlist {
        let entries = try DPL.parse(text)
        let items = entries.map { PlaylistItem(file: $0.file, title: $0.title, position: $0.position) }
        let playlist = try createList(name: name)
        playlist.items = items
        try save(playlist)
        return playlist
    }
}
