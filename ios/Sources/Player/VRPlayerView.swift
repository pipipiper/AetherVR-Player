import SwiftUI
import KSPlayer

/// VR 显示模式
enum VRDisplayMode: String, CaseIterable, Identifiable {
    case plane = "平面"
    case vr360 = "360°"
    case vrBox = "VR 眼镜分屏"

    var id: String { rawValue }

    var displayEnum: DisplayEnum {
        switch self {
        case .plane: return .plane
        case .vr360: return .vr
        case .vrBox: return .vrBox
        }
    }
}

/// 播放器封装：底层用 KSPlayer 自带的完整播放界面（控制条/字幕/轨道选择），
/// 在此之上配置 VR 球面渲染与硬解。
/// 陀螺仪：KSPlayer 在球面模式下默认启用（enableSensor 未公开，无法从外部关闭；
/// 后续 fork KSPlayer 加 SBS/180° UV 控制时可一并暴露开关）。
struct VRPlayerView: View {
    let url: URL
    let title: String
    var startPosition: TimeInterval = 0
    var mode: VRDisplayMode = .vr360
    /// WebDAV 等需要认证头时传入（如 ["Authorization": "Basic ..."]）
    var httpHeaders: [String: String] = [:]

    var body: some View {
        KSVideoPlayerView(
            url: url,
            options: Self.makeOptions(
                mode: mode,
                start: startPosition,
                headers: httpHeaders
            ),
            title: title
        )
        .ignoresSafeArea()
    }

    static func makeOptions(
        mode: VRDisplayMode,
        start: TimeInterval,
        headers: [String: String]
    ) -> KSOptions {
        let options = KSOptions()
        options.display = mode.displayEnum
        options.startPlayTime = start
        options.hardwareDecode = true
        options.isSecondOpen = true
        if !headers.isEmpty {
            options.appendHeader(headers)
        }
        return options
    }
}
