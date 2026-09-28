import Foundation
import AMSMB2

/// SMB 服务器连接配置
struct SMBServerConfig: Equatable, Codable {
    var host: String
    var port: Int = 445
    /// 可选，留空表示先列共享
    var share: String = ""
    var username: String = ""
    var password: String = ""
    var domain: String = ""

    var serverURL: URL? {
        var components = URLComponents()
        components.scheme = "smb"
        components.host = host
        if port != 445 { components.port = port }
        return components.url
    }
}

struct SMBItem: Equatable, Identifiable {
    var id: String { path }
    var name: String
    var path: String
    var isDirectory: Bool
    var size: Int64
}

enum SMBError: Error, Equatable {
    case invalidServer
    case connectFailed(String)
}

/// SMB 浏览客户端（AMSMB2/libsmb2）。播放不走这里：FFmpegKit 内置 libsmbclient，
/// 直接给 KSPlayer 喂 smb:// 链接即可硬件解码串流。
final class SMBClient {
    let config: SMBServerConfig

    init(config: SMBServerConfig) {
        self.config = config
    }

    private func makeManager() -> SMB2Manager? {
        guard let url = config.serverURL else { return nil }
        let credential: URLCredential? = config.username.isEmpty
            ? nil
            : URLCredential(
                user: config.username,
                password: config.password,
                persistence: .forSession
            )
        return SMB2Manager(url: url, domain: config.domain, credential: credential)
    }

    /// 列出服务器上的共享名（无需先连接共享）
    func listShares() async throws -> [String] {
        guard let manager = makeManager() else { throw SMBError.invalidServer }
        return try await withCheckedThrowingContinuation { continuation in
            manager.listShares(enumerateHidden: false) { result in
                continuation.resume(with: result.map { shares in
                    shares.map { $0.name }.sorted()
                })
            }
        }
    }

    /// 列出共享内目录内容
    func list(path: String) async throws -> [SMBItem] {
        guard let manager = makeManager() else { throw SMBError.invalidServer }
        guard !config.share.isEmpty else { throw SMBError.connectFailed("未指定共享名") }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            manager.connectShare(name: config.share) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
        let entries: [[URLResourceKey: any Sendable]] = try await withCheckedThrowingContinuation { continuation in
            manager.contentsOfDirectory(atPath: path) { result in
                continuation.resume(with: result)
            }
        }
        return entries
            .compactMap { dict -> SMBItem? in
                guard let name = dict[.nameKey] as? String,
                      !name.hasPrefix(".") else { return nil }
                let isDirectory = dict[.isDirectoryKey] as? Bool ?? false
                let size = dict[.fileSizeKey] as? Int64 ?? 0
                let fullPath = Self.join(path, name)
                return SMBItem(name: name, path: fullPath, isDirectory: isDirectory, size: size)
            }
            .sorted { lhs, rhs in
                if lhs.isDirectory != rhs.isDirectory { return lhs.isDirectory }
                return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
            }
    }

    /// 生成可直接给 KSPlayer 播放的 smb:// 链接（内嵌凭据）
    func playURL(path: String) -> URL? {
        var components = URLComponents()
        components.scheme = "smb"
        components.host = config.host
        if config.port != 445 { components.port = config.port }
        if !config.username.isEmpty {
            components.user = config.username
            if !config.password.isEmpty {
                components.percentEncodedPassword =
                    config.password.addingPercentEncoding(withAllowedCharacters: .urlPasswordAllowed)
            }
        }
        components.path = "/\(config.share)\(path.hasPrefix("/") ? path : "/" + path)"
        return components.url
    }

    static func join(_ path: String, _ name: String) -> String {
        let base = path.hasSuffix("/") ? String(path.dropLast()) : path
        return base + "/" + name
    }
}
