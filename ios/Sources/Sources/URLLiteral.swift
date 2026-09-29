import Foundation

/// 保留原始编码的 URL 构造。
/// Foundation 的 URL(string:) 会把路径里已有的 %20 二次编码成 %2520，
/// openlist/网盘签名链接因此 404。这里手动拆 scheme/authority/path/query，
/// 只对非 ASCII 字符做编码，已有的百分号序列原样保留。
enum URLLiteral {
    static func http(_ raw: String) -> URL? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let schemeEnd = text.range(of: "://") else { return nil }
        let scheme = text[..<schemeEnd.lowerBound].lowercased()
        guard scheme == "http" || scheme == "https" else { return nil }
        let rest = text[schemeEnd.upperBound...]
        guard let pathStart = rest.firstIndex(of: "/") else {
            // 无路径（裸域名）
            let authority = String(rest)
            let hostParts = authority.split(separator: ":")
            guard let host = hostParts.first, !host.isEmpty else { return nil }
            var c = URLComponents()
            c.scheme = String(scheme)
            c.host = String(host)
            if hostParts.count > 1 { c.port = Int(hostParts[1]) }
            return c.url
        }
        var c = URLComponents()
        c.scheme = String(scheme)
        let authority = String(rest[..<pathStart])
        let hostParts = authority.split(separator: ":")
        guard let host = hostParts.first, !host.isEmpty else { return nil }
        c.host = String(host)
        if hostParts.count > 1 { c.port = Int(hostParts[1]) }
        let pathAndQuery = String(rest[pathStart...])
        if let q = pathAndQuery.firstIndex(of: "?") {
            c.percentEncodedPath = sanitize(String(pathAndQuery[..<q]))
            c.percentEncodedQuery = sanitize(String(pathAndQuery[pathAndQuery.index(after: q)...]))
        } else {
            c.percentEncodedPath = sanitize(pathAndQuery)
        }
        return c.url
    }

    /// 为 percentEncodedPath/percentEncodedQuery 消毒：
    /// - 非法的 % 序列（不完整或非十六进制）编码为 %25，否则 Foundation 直接 assert 崩溃
    /// - [ ] 编码为 %5B %5D（percentEncodedPath 不接受裸方括号）
    /// - 非 ASCII 字符做百分号编码，已有的合法 %XX 序列原样保留
    private static func sanitize(_ s: String) -> String {
        var out = ""
        var i = s.startIndex
        let hex = Set("0123456789abcdefABCDEF")
        while i < s.endIndex {
            let ch = s[i]
            if ch == "%" {
                let j = s.index(i, offsetBy: 1, limitedBy: s.endIndex)
                let k = j.flatMap { $0 < s.endIndex ? s.index($0, offsetBy: 1, limitedBy: s.endIndex) : nil }
                if let j, j < s.endIndex, let k, k < s.endIndex,
                   hex.contains(s[j]), hex.contains(s[k]) {
                    out.append(ch)
                } else {
                    out += "%25"
                }
            } else if ch == "[" {
                out += "%5B"
            } else if ch == "]" {
                out += "%5D"
            } else if ch.isASCII {
                // percentEncodedPath 同样不接受空格及 " < > # { } | \ ^ ` 等裸字符
                let escapeSet: Set<Character> = [" ", "\"", "<", ">", "#", "{", "}", "|", "\\", "^", "`"]
                if escapeSet.contains(ch) {
                    out += String(ch).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""
                } else {
                    out.append(ch)
                }
            } else {
                out += String(ch).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""
            }
            i = s.index(after: i)
        }
        return out
    }
}
