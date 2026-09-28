import Foundation
import Security

/// 最近连接过的服务器（SMB / WebDAV）
struct RecentServer: Codable, Identifiable, Equatable {
    var id = UUID()
    /// "smb" 或 "webdav"
    var type: String
    /// smb: "host:port"；webdav: 完整 baseURL
    var address: String
    var username: String

    var keychainAccount: String { "\(type)|\(address)|\(username)" }
}

enum ServerHistory {
    private static let key = "recentServers"
    private static let maxCount = 10

    static func load(type: String) -> [RecentServer] {
        let all = (UserDefaults.standard.array(forKey: key) as? [Data])?.compactMap {
            try? JSONDecoder().decode(RecentServer.self, from: $0)
        } ?? []
        return all.filter { $0.type == type }
    }

    /// 连接成功后记录（同类型+地址+用户名去重，最新的排最前）
    static func remember(type: String, address: String, username: String, password: String) {
        var all = (UserDefaults.standard.array(forKey: key) as? [Data])?.compactMap {
            try? JSONDecoder().decode(RecentServer.self, from: $0)
        } ?? []
        all.removeAll { $0.type == type && $0.address == address && $0.username == username }
        var server = RecentServer(type: type, address: address, username: username)
        // 保持稳定 id：沿用旧条目的 id
        server.id = all.first { $0.type == type && $0.address == address && $0.username == username }?.id ?? server.id
        all.insert(server, at: 0)
        let trimmed = Array(all.prefix(maxCount * 2))
        UserDefaults.standard.set(trimmed.map { try? JSONEncoder().encode($0) }, forKey: key)
        if !password.isEmpty {
            KeychainStore.save(password: password, account: server.keychainAccount)
        }
    }

    static func password(for server: RecentServer) -> String? {
        KeychainStore.read(account: server.keychainAccount)
    }

    static func remove(_ server: RecentServer) {
        var all = (UserDefaults.standard.array(forKey: key) as? [Data])?.compactMap {
            try? JSONDecoder().decode(RecentServer.self, from: $0)
        } ?? []
        all.removeAll { $0.id == server.id }
        UserDefaults.standard.set(all.map { try? JSONEncoder().encode($0) }, forKey: key)
        KeychainStore.delete(account: server.keychainAccount)
    }
}

/// 极简 Keychain 封装（存服务器密码）
enum KeychainStore {
    private static let service = "com.aethervr.player"

    static func save(password: String, account: String) {
        let data = Data(password.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(insert as CFDictionary, nil)
    }

    static func read(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
