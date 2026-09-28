import SwiftUI

/// 在线链接播放：粘贴直链，选择显示模式后起播
struct URLPlaySheet: View {
    struct PlaybackTarget: Identifiable {
        let id = UUID()
        let url: URL
        let title: String
        let mode: VRDisplayMode
        var position: TimeInterval = 0
        var headers: [String: String] = [:]
        var hardwareDecode: Bool = true
    }

    @Environment(\.dismiss) private var dismiss
    @State private var urlText = ""
    @State private var mode: VRDisplayMode = .vr360
    @State private var hardwareDecode = true
    @State private var playback: PlaybackTarget?

    var body: some View {
        NavigationStack {
            Form {
                Section("视频链接") {
                    TextField("https://…", text: $urlText)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section("显示模式") {
                    Picker("投影", selection: $mode) {
                        ForEach(VRDisplayMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    Picker("解码", selection: $hardwareDecode) {
                        Text("硬件解码").tag(true)
                        Text("软件解码").tag(false)
                    }
                }
            }
            .navigationTitle("播放在线链接")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("播放") { startPlayback() }
                        .disabled(parsedURL == nil)
                }
            }
            .fullScreenCover(item: $playback) { target in
                VRPlayerView(
                    url: target.url,
                    title: target.title,
                    mode: target.mode,
                    hardwareDecode: target.hardwareDecode
                )
            }
        }
        .presentationDetents([.medium])
    }

    private var parsedURL: URL? {
        let text = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme), url.host != nil else {
            return nil
        }
        return url
    }

    private func startPlayback() {
        guard let url = parsedURL else { return }
        let name = url.lastPathComponent.removingPercentEncoding ?? url.lastPathComponent
        playback = PlaybackTarget(
            url: url,
            title: name.isEmpty ? "在线视频" : name,
            mode: mode,
            hardwareDecode: hardwareDecode
        )
    }
}

#Preview {
    URLPlaySheet()
        .preferredColorScheme(.dark)
}
