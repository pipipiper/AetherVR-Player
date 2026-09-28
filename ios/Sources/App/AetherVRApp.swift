import SwiftUI

@main
struct AetherVRApp: App {
    @StateObject private var playlistStore = PlaylistStore()

    init() {
        SettingsKeys.registerDefaults()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
                .environmentObject(playlistStore)
                .task {
                    try? playlistStore.load()
                }
        }
    }
}
