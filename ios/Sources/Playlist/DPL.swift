import Foundation

/// 与网页版 index.html 的 parseDpl/buildDpl 行为对齐的 DPL（PotPlayer）播放列表格式。
/// 格式：
///   DAUMPLAYLIST
///   1*file*<路径或链接>
///   1*title*<标题>
///   1*position*<秒>
struct DplEntry: Equatable {
    var file: String
    var title: String
    /// 起播位置（秒），0 表示从头播放
    var position: Int
    /// 解析时保留的其他字段（如 PotPlayer 的 played 标记），导出时不写出
    var extras: [String: String]

    init(file: String, title: String = "", position: Int = 0, extras: [String: String] = [:]) {
        self.file = file
        self.title = title
        self.position = position
        self.extras = extras
    }
}

enum DplError: Error, Equatable {
    case invalidFormat
}

enum DPL {
    /// 解析 dpl 文本。非 dpl 内容抛出 DplError.invalidFormat；无条目返回空数组。
    static func parse(_ text: String) throws -> [DplEntry] {
        guard text.prefix(200).range(of: "DAUMPLAYLIST", options: .caseInsensitive) != nil else {
            throw DplError.invalidFormat
        }
        var order: [Int] = []
        var grouped: [Int: [String: String]] = [:]
        for line in text.components(separatedBy: .newlines) {
            // 对齐 JS 的 /^(\d+)\*([^*]+)\*(.*)$/
            guard let match = line.wholeMatch(of: #/(\d+)\*([^*]+)\*(.*)/#) else { continue }
            guard let index = Int(match.1) else { continue }
            let key = String(match.2).lowercased()
            let value = match.3.trimmingCharacters(in: .whitespaces)
            if grouped[index] == nil {
                grouped[index] = [:]
                order.append(index)
            }
            grouped[index]![key] = value
        }
        return order.sorted().compactMap { index in
            guard let fields = grouped[index], let file = fields["file"], !file.isEmpty else { return nil }
            return DplEntry(
                file: file,
                title: fields["title"] ?? "",
                position: Int(fields["position"] ?? "") ?? 0,
                extras: fields.filter { !["file", "title", "position"].contains($0.key) }
            )
        }
    }

    /// 生成 dpl 文本（CRLF 行尾，与网页版导出一致）。
    static func build(_ entries: [DplEntry]) -> String {
        var lines = ["DAUMPLAYLIST"]
        for (i, entry) in entries.enumerated() {
            let n = i + 1
            lines.append("\(n)*file*\(entry.file)")
            let title = entry.title
                .replacingOccurrences(of: "\r", with: " ")
                .replacingOccurrences(of: "\n", with: " ")
                .replacingOccurrences(of: "*", with: " ")
            lines.append("\(n)*title*\(title)")
            if entry.position > 0 {
                lines.append("\(n)*position*\(entry.position)")
            }
        }
        return lines.joined(separator: "\r\n")
    }
}
