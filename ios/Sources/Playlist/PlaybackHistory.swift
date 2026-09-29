import Foundation

/// 一条播放记录（以 url 为主键去重）
struct PlaybackRecord: Codable, Identifiable, Equatable {
    var id: String { url }
    var title: String
    var url: String
    /// 看到的位置（秒）
    var position: Int
    /// 总时长（秒）
    var duration: Int
    var updatedAt: Date
}

/// 播放记录仓库：Documents/history.json，最多保留 200 条
@MainActor
final class PlaybackHistoryStore: ObservableObject {
    @Published private(set) var records: [PlaybackRecord] = []

    private let fileURL: URL
    private let maxCount = 200

    init(directory: URL? = nil) {
        let dir = directory
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        fileURL = dir.appendingPathComponent("history.json")
        load()
    }

    func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode([PlaybackRecord].self, from: data) else {
            records = []
            return
        }
        records = decoded.sorted { $0.updatedAt > $1.updatedAt }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(records) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    /// 播放/退出/切集时更新记录（同 url 覆盖）
    func upsert(title: String, url: String, position: Int, duration: Int) {
        let record = PlaybackRecord(
            title: title, url: url,
            position: position, duration: duration,
            updatedAt: Date()
        )
        if let idx = records.firstIndex(where: { $0.url == url }) {
            records[idx] = record
        } else {
            records.append(record)
        }
        records.sort { $0.updatedAt > $1.updatedAt }
        if records.count > maxCount {
            records = Array(records.prefix(maxCount))
        }
        persist()
    }

    func remove(_ record: PlaybackRecord) {
        records.removeAll { $0.url == record.url }
        persist()
    }

    func removeAll() {
        records = []
        persist()
    }
}
