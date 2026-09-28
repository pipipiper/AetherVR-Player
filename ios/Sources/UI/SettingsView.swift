import SwiftUI

/// 全局设置（UserDefaults）
enum SettingsKeys {
    static let defaultProjection = "defaultProjection"     // String: VRDisplayMode.rawValue
    static let defaultHardwareDecode = "defaultHardwareDecode" // Bool
    static let gyroDefaultOn = "gyroDefaultOn"             // Bool
    static let autoPlayNext = "autoPlayNext"               // Bool
    static let rememberPosition = "rememberPosition"       // Bool

    static func registerDefaults() {
        UserDefaults.standard.register(defaults: [
            defaultProjection: VRDisplayMode.vr360.rawValue,
            defaultHardwareDecode: true,
            gyroDefaultOn: false,
            autoPlayNext: true,
            rememberPosition: true,
        ])
    }
}

struct SettingsView: View {
    @AppStorage(SettingsKeys.defaultProjection) private var defaultProjection = VRDisplayMode.vr360.rawValue
    @AppStorage(SettingsKeys.defaultHardwareDecode) private var defaultHardwareDecode = true
    @AppStorage(SettingsKeys.gyroDefaultOn) private var gyroDefaultOn = false
    @AppStorage(SettingsKeys.autoPlayNext) private var autoPlayNext = true
    @AppStorage(SettingsKeys.rememberPosition) private var rememberPosition = true

    var body: some View {
        NavigationStack {
            Form {
                Section("播放") {
                    Picker("默认投影模式", selection: $defaultProjection) {
                        ForEach(VRDisplayMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode.rawValue)
                        }
                    }
                    Picker("默认解码方式", selection: $defaultHardwareDecode) {
                        Text("硬件解码（推荐）").tag(true)
                        Text("软件解码").tag(false)
                    }
                    Toggle("默认开启陀螺仪", isOn: $gyroDefaultOn)
                    Toggle("自动播放下一集", isOn: $autoPlayNext)
                    Toggle("记忆播放进度", isOn: $rememberPosition)
                }
                Section("关于") {
                    LabeledContent("版本", value: "0.1.0 (iOS)")
                    LabeledContent("播放内核", value: "KSPlayer（GPL）· FFmpeg · VideoToolbox")
                    Text("AetherVR Player 以 AGPL-3.0 开源；KSPlayer 以 GPL 授权使用；"
                         + "FFmpeg 及 libsmbclient/libdav1d 等组件归各自作者所有。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("设置")
        }
    }
}

#Preview {
    SettingsView()
        .preferredColorScheme(.dark)
}
