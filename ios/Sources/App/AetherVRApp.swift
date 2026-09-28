import SwiftUI

@main
struct AetherVRApp: App {
    @StateObject private var playlistStore = PlaylistStore()
    @AppStorage(SettingsKeys.appearance) private var appearance = "dark"

    init() {
        SettingsKeys.registerDefaults()
    }

    private var colorScheme: ColorScheme? {
        switch appearance {
        case "light": return .light
        case "dark": return .dark
        default: return nil // 跟随系统
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(colorScheme)
                .environmentObject(playlistStore)
                .task {
                    try? playlistStore.load()
                }
        }
    }
}
