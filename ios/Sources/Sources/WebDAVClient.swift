import Foundation

/// WebDAV 目录条目
struct WebDAVItem: Equatable {
    var name: String
    /// 服务器上的绝对路径（已解码，含 basePath 前缀）
    var path: String
    var isDirectory: Bool
    var size: Int64
    var modifiedAt: Date?
}

enum WebDAVError: Error, Equatable {
    case invalidURL
    case httpError(Int)
    case badResponse
}

extension WebDAVError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "服务器地址格式不正确"
        case .httpError(let code):
            switch code {
            case 401: return "认证失败（401）：请检查用户名和密码"
            case 403: return "没有访问权限（403）"
            case 404: return "路径不存在（404）：请确认 WebDAV 路径（如 /dav）"
            case 405: return "该地址不支持 WebDAV（405）：请确认地址是 WebDAV 端点（如 …/dav）"
            default: return "服务器返回错误（HTTP \(code)）"
            }
        case .badResponse:
            return "服务器响应格式不正确"
        }
    }
}

/// PROPFIND (Depth: 1) 的 multistatus XML 解析，与具体网络层解耦便于测试。
/// 命名空间无关：只按 local name 匹配 href/displayname/getcontentlength/resourcetype/collection。
enum WebDAVParser {
    static func parse(data: Data, requestedPath: String) -> [WebDAVItem] {
        let delegate = MultistatusDelegate()
        let parser = XMLParser(data: data)
        parser.delegate = delegate
        parser.shouldProcessNamespaces = false
        parser.shouldReportNamespacePrefixes = false
        guard parser.parse() else { return [] }
        let normalizedRequest = Self.normalize(requestedPath)
        return delegate.items
            .filter { Self.normalize($0.path) != normalizedRequest }
            .sorted { lhs, rhs in
                if lhs.isDirectory != rhs.isDirectory { return lhs.isDirectory }
                return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
            }
    }

    static func normalize(_ path: String) -> String {
        var p = path
        if p.count > 1, p.hasSuffix("/") { p.removeLast() }
        return p
    }
}

private final class MultistatusDelegate: NSObject, XMLParserDelegate {
    private(set) var items: [WebDAVItem] = []

    private var inResponse = false
    private var currentHref: String?
    private var currentName: String?
    private var currentSize: Int64 = 0
    private var currentIsCollection = false
    private var currentModified: Date?
    private var text = ""

    private static let dateFormatters: [DateFormatter] = {
        let formats = ["yyyy-MM-dd'T'HH:mm:ss.SSSZ", "yyyy-MM-dd'T'HH:mm:ssZ"]
        return formats.map { fmt in
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = fmt
            return f
        }
    }()

    private static func localName(_ elementName: String) -> String {
        // shouldProcessNamespaces=false 时 elementName 带前缀（如 "D:response"），取本地名
        elementName.split(separator: ":").last.map(String.init) ?? elementName
    }

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?,
                qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]) {
        text = ""
        switch Self.localName(elementName) {
        case "response":
            inResponse = true
            currentHref = nil
            currentName = nil
            currentSize = 0
            currentIsCollection = false
            currentModified = nil
        case "collection" where inResponse:
            currentIsCollection = true
        default:
            break
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        text += string
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?,
                qualifiedName qName: String?) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        switch Self.localName(elementName) {
        case "href" where inResponse && currentHref == nil:
            currentHref = value.removingPercentEncoding ?? value
        case "displayname" where inResponse:
            currentName = value
        case "getcontentlength" where inResponse:
            currentSize = Int64(value) ?? 0
        case "getlastmodified" where inResponse:
            // RFC 1123 等格式不关键，解析失败就留空
            currentModified = Self.dateFormatters.compactMap { $0.date(from: value) }.first
        case "response":
            if inResponse, let href = currentHref {
                let name = currentName?.isEmpty == false
                    ? currentName!
                    : (WebDAVParser.normalize(href) as NSString).lastPathComponent
                items.append(WebDAVItem(
                    name: name,
                    path: href,
                    isDirectory: currentIsCollection,
                    size: currentSize,
                    modifiedAt: currentModified
                ))
            }
            inResponse = false
        default:
            break
        }
        text = ""
    }
}

/// 轻量 WebDAV 客户端：PROPFIND 列目录 + 生成可播放的 GET 地址。
final class WebDAVClient: @unchecked Sendable {
    let baseURL: URL
    private let authorization: String?
    private let session: URLSession

    /// - Parameters:
    ///   - baseURL: 服务器根，如 https://nas.example.com:5006/dav
    ///   - username/password: 可空（匿名）
    init(baseURL: URL, username: String? = nil, password: String? = nil, session: URLSession = .shared) {
        self.baseURL = baseURL
        if let username, !username.isEmpty {
            let raw = "\(username):\(password ?? "")"
            self.authorization = "Basic " + Data(raw.utf8).base64EncodedString()
        } else {
            self.authorization = nil
        }
        self.session = session
    }

    /// 列出目录。path="/" 表示 baseURL 的根（如 /dav）；子目录传入 href 里的服务器绝对路径
    func list(path: String) async throws -> [WebDAVItem] {
        guard let url = makeURL(serverPath: path) else {
            throw WebDAVError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "PROPFIND"
        request.setValue("1", forHTTPHeaderField: "Depth")
        request.setValue("application/xml; charset=utf-8", forHTTPHeaderField: "Content-Type")
        if let authorization { request.setValue(authorization, forHTTPHeaderField: "Authorization") }
        request.httpBody = Data("""
        <?xml version="1.0" encoding="utf-8"?>
        <D:propfind xmlns:D="DAV:">
          <D:prop>
            <D:displayname/><D:getcontentlength/><D:resourcetype/><D:getlastmodified/>
          </D:prop>
        </D:propfind>
        """.utf8)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw WebDAVError.badResponse }
        guard (200..<300).contains(http.statusCode) else { throw WebDAVError.httpError(http.statusCode) }
        return WebDAVParser.parse(data: data, requestedPath: url.path)
    }

    /// 供 KSPlayer 播放的完整 URL；认证信息通过 KSOptions header 传递
    func fileURL(path: String) -> URL? {
        makeURL(serverPath: path)
    }

    /// 构造请求 URL：不用 URL(relativeTo:)（iOS 上 "/" 会丢掉 baseURL 的 /dav 前缀，
    /// 且部分系统版本 relativeTo 返回 nil 导致 invalidURL）
    private func makeURL(serverPath: String) -> URL? {
        var components = URLComponents()
        components.scheme = baseURL.scheme
        components.host = baseURL.host
        components.port = baseURL.port
        if serverPath == "/" || serverPath.isEmpty {
            // 列根目录 = baseURL 自身路径（如 /dav）
            components.path = baseURL.path.hasSuffix("/") ? baseURL.path : baseURL.path + "/"
        } else {
            // 子目录 href 是服务器绝对路径（已含 basePath 前缀）
            components.path = serverPath
        }
        return components.url
    }

    /// 播放/下载时附加的认证头
    var authorizationHeader: [String: String] {
        authorization.map { ["Authorization": $0] } ?? [:]
    }
}
