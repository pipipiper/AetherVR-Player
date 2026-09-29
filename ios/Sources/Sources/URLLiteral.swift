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
            var c = URLComponents()
            c.scheme = String(scheme)
            let authority = String(rest)
            let hostParts = authority.split(separator: ":")
            c.host = String(hostParts[0])
            if hostParts.count > 1 { c.port = Int(hostParts[1]) }
            return c.url
        }
        var c = URLComponents()
        c.scheme = String(scheme)
        let authority = String(rest[..<pathStart])
        let hostParts = authority.split(separator: ":")
        c.host = String(hostParts[0])
        if hostParts.count > 1 { c.port = Int(hostParts[1]) }
        let pathAndQuery = String(rest[pathStart...])
        if let q = pathAndQuery.firstIndex(of: "?") {
            c.percentEncodedPath = encodeNonASCII(String(pathAndQuery[..<q]))
            c.percentEncodedQuery = encodeNonASCII(String(pathAndQuery[pathAndQuery.index(after: q)...]))
        } else {
            c.percentEncodedPath = encodeNonASCII(pathAndQuery)
        }
        return c.url
    }

    private static func encodeNonASCII(_ s: String) -> String {
        var out = ""
        for scalar in s.unicodeScalars {
            if scalar.isASCII {
                out.unicodeScalars.append(scalar)
            } else {
                out += String(scalar).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""
            }
        }
        return out
    }
}
