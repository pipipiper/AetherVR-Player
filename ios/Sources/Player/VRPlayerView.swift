import SwiftUI
import KSPlayer

/// VR 显示模式
enum VRDisplayMode: String, CaseIterable, Identifiable {
    case plane = "平面"
    case vr360 = "360°"
    case vr180 = "180°"
    case vrBox = "VR 眼镜分屏"

    var id: String { rawValue }

    var displayEnum: DisplayEnum {
        switch self {
        case .plane: return .plane
        case .vr360: return .vr
        case .vr180: return .vr180
        case .vrBox: return .vrBox
        }
    }
}

/// 播放器封装：裸 KSVideoPlayer（无自带控制层，避免亮度/音量拖动手势
/// 和球面视角拖动打架）+ 自绘控制层。
/// 陀螺仪默认关闭，手动拖动调视角；双指缩放调 FOV；可切换软硬解与投影模式。
struct VRPlayerView: View {
    let url: URL
    let title: String
    var startPosition: TimeInterval
    var mode: VRDisplayMode
    /// WebDAV 等需要认证头时传入（如 ["Authorization": "Basic ..."]）
    var httpHeaders: [String: String]

    @Environment(\.dismiss) private var dismiss
    @StateObject private var coordinator = KSVideoPlayer.Coordinator()
    @State private var gyroEnabled = false
    @State private var showControls = true
    @State private var playerState: KSPlayerState = .initialized
    @State private var isSeeking = false
    @State private var seekPosition: Double = 0
    @State private var hideControlsTask: DispatchWorkItem?
    /// 双指缩放 FOV 的基准值（弧度）
    @State private var baseFov: Float = .pi / 3
    /// SwiftUI 手势直控视角的基准值（弧度）
    @State private var yawBase: Float = 0
    @State private var pitchBase: Float = 0
    /// 软/硬解与投影模式：切换会重建播放器，rebuildToken 驱动 .id/.task
    @State private var hardwareDecode: Bool
    @State private var modeOverride: VRDisplayMode?
    /// 重建播放器时恢复到的进度
    @State private var resumeTime: TimeInterval?
    /// 重建期间的短暂卸载窗口（让旧播放器异步关停走完）
    @State private var playerVisible = true

    init(url: URL, title: String, startPosition: TimeInterval = 0,
         mode: VRDisplayMode = .vr360, httpHeaders: [String: String] = [:],
         hardwareDecode: Bool = true) {
        self.url = url
        self.title = title
        self.startPosition = startPosition
        self.mode = mode
        self.httpHeaders = httpHeaders
        _hardwareDecode = State(initialValue: hardwareDecode)
    }

    private var effectiveMode: VRDisplayMode { modeOverride ?? mode }
    private var rebuildToken: String { "\(hardwareDecode)-\(effectiveMode.rawValue)" }

    private var options: KSOptions {
        let options = KSOptions()
        options.display = effectiveMode.displayEnum
        options.startPlayTime = resumeTime ?? startPosition
        options.hardwareDecode = hardwareDecode
        // 关键：默认 false 时 MEPlayer 用 FFmpeg 软解，8K 直接卡成幻灯片；
        // 打开后走 VideoToolbox 硬解（DecompressionSession），不支持的编码会自动回退软解
        options.asynchronousDecompression = true
        options.isSecondOpen = true
        if !httpHeaders.isEmpty {
            options.appendHeader(httpHeaders)
        }
        return options
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if playerVisible {
                KSVideoPlayer(coordinator: coordinator, url: url, options: options)
                    .id(rebuildToken)
                    .ignoresSafeArea()
                    .onTapGesture {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            showControls.toggle()
                        }
                        if showControls { scheduleAutoHide() }
                    }
                    .simultaneousGesture(
                        // SwiftUI 直控视角：绕过 KSPlayer 的 UIKit touchesMoved 路径
                        DragGesture(minimumDistance: 0)
                            .onChanged { value in
                                guard effectiveMode != .plane, !gyroEnabled else { return }
                                let yaw = yawBase - Float(value.translation.width) * 0.004
                                let pitch = pitchBase - Float(value.translation.height) * 0.004
                                KSOptions.vrYaw = yaw
                                KSOptions.vrPitch = min(max(pitch, -.pi / 2), .pi / 2)
                            }
                            .onEnded { _ in
                                yawBase = KSOptions.vrYaw ?? 0
                                pitchBase = KSOptions.vrPitch ?? 0
                            }
                    )
                    .simultaneousGesture(
                        MagnificationGesture()
                            .onChanged { scale in
                                guard effectiveMode != .plane else { return }
                                let fov = baseFov / Float(scale)
                                KSOptions.vrFov = min(max(fov, .pi / 6), .pi * 2 / 3)
                            }
                            .onEnded { _ in
                                baseFov = KSOptions.vrFov
                            }
                    )
            } else {
                // 重建中（切换软硬解/投影模式）
                VStack(spacing: 12) {
                    ProgressView().tint(.white)
                    Text("正在切换…")
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.8))
                }
            }
            if showControls {
                controlsOverlay
                    .transition(.opacity)
            }
            // 重建中只显示「正在切换…」，不再叠缓冲转圈
            if playerVisible && (playerState == .buffering || playerState == .initialized) {
                ProgressView()
                    .tint(.white)
                    .scaleEffect(1.3)
                    .allowsHitTesting(false)
            }
        }
        .statusBarHidden(true)
        .task(id: rebuildToken) {
            attachCallbacks()
        }
        .onAppear {
            gyroEnabled = false
            KSOptions.enableSensor = false
            // 启用 SwiftUI 外部视角控制（fork: vrYaw/vrPitch 非 nil 时优先于内置旋转/陀螺仪）
            KSOptions.vrYaw = 0
            KSOptions.vrPitch = 0
            yawBase = 0
            pitchBase = 0
            coordinator.isMaskShow = false
            scheduleAutoHide()
        }
        .onDisappear {
            KSOptions.vrYaw = nil
            KSOptions.vrPitch = nil
            coordinator.resetPlayer()
        }
    }

    private var controlsOverlay: some View {
        VStack {
            // 顶部：返回、标题、投影模式、软硬解、陀螺仪开关
            HStack(spacing: 10) {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.left")
                        .font(.headline)
                        .frame(width: 36, height: 36)
                }
                Text(title)
                    .font(.caption)
                    .lineLimit(1)
                Spacer()
                Menu {
                    Picker("投影模式", selection: Binding(
                        get: { effectiveMode },
                        set: { newMode in
                            rebuildPlayer { modeOverride = newMode }
                        }
                    )) {
                        ForEach(VRDisplayMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                } label: {
                    Text(effectiveMode.rawValue)
                        .font(.footnote)
                        .frame(minWidth: 44)
                }
                Button {
                    rebuildPlayer { hardwareDecode.toggle() }
                } label: {
                    Text(hardwareDecode ? "硬解" : "软解")
                        .font(.footnote)
                }
                if effectiveMode != .plane {
                    Button {
                        gyroEnabled.toggle()
                        KSOptions.enableSensor = gyroEnabled
                        if gyroEnabled {
                            // 交还给陀螺仪驱动
                            KSOptions.vrYaw = nil
                            KSOptions.vrPitch = nil
                        } else {
                            // 回到手动拖动，从正前方重新开始
                            KSOptions.vrYaw = 0
                            KSOptions.vrPitch = 0
                            yawBase = 0
                            pitchBase = 0
                        }
                        scheduleAutoHide()
                    } label: {
                        Label(gyroEnabled ? "陀螺仪：开" : "陀螺仪：关",
                              systemImage: "gyroscope")
                            .font(.footnote)
                    }
                }
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.black.opacity(0.45))

            Spacer()

            // 底部：播放/暂停 + 进度条
            HStack(spacing: 12) {
                Button {
                    if playerState.isPlaying {
                        coordinator.playerLayer?.pause()
                    } else {
                        coordinator.playerLayer?.play()
                    }
                    scheduleAutoHide()
                } label: {
                    Image(systemName: playerState.isPlaying ? "pause.fill" : "play.fill")
                        .font(.title3)
                        .frame(width: 36, height: 36)
                }
                PlayerTimeSlider(
                    timemodel: coordinator.timemodel,
                    isSeeking: $isSeeking,
                    seekPosition: $seekPosition,
                    onSeek: { time in
                        coordinator.seek(time: time)
                        scheduleAutoHide()
                    }
                )
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.black.opacity(0.45))

            // 渲染诊断（临时，定位手势卡顿用）
            TimelineView(.periodic(from: .now, by: 0.5)) { _ in
                let info = coordinator.playerLayer?.player.dynamicInfo
                Text(String(
                    format: "渲染 %.0ffps · 丢帧 %u · FOV %.0f°",
                    info?.displayFPS ?? 0,
                    info?.droppedVideoFrameCount ?? 0,
                    Double(KSOptions.vrFov) * 180 / .pi
                ))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.white.opacity(0.7))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
            }
        }
    }

    /// 挂播放器状态回调（dismantle 会清空，重建后必须重挂）
    private func attachCallbacks() {
        coordinator.onStateChanged = { _, state in
            playerState = state
        }
        coordinator.onFinish = { _, error in
            if error == nil { dismiss() }
        }
    }

    /// 切换软硬解/投影模式：先停旧播放器并卸载播放视图，给异步关停让出时间后再重建，
    /// 避免新旧两个 8K 解码管线并存把主线程/内存挤爆
    private func rebuildPlayer(_ change: () -> Void) {
        resumeTime = Double(coordinator.timemodel.currentTime)
        coordinator.playerLayer?.stop()
        playerVisible = false
        change()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            // dismantle 已走完：先重挂回调，再让 SwiftUI 建新播放器
            attachCallbacks()
            playerVisible = true
            scheduleAutoHide()
        }
    }

    private func scheduleAutoHide() {
        hideControlsTask?.cancel()
        let task = DispatchWorkItem {
            withAnimation(.easeInOut(duration: 0.2)) {
                showControls = false
            }
        }
        hideControlsTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: task)
    }
}

/// 进度条：独立于 coordinator 观察 timemodel，拖动时不被播放进度回写干扰
private struct PlayerTimeSlider: View {
    @ObservedObject var timemodel: ControllerTimeModel
    @Binding var isSeeking: Bool
    @Binding var seekPosition: Double
    let onSeek: (TimeInterval) -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text(formatTime(isSeeking ? seekPosition : Double(timemodel.currentTime)))
                .font(.caption.monospacedDigit())
            Slider(
                value: Binding(
                    get: { isSeeking ? seekPosition : Double(timemodel.currentTime) },
                    set: { seekPosition = $0 }
                ),
                in: 0...max(1, Double(timemodel.totalTime)),
                onEditingChanged: { editing in
                    if editing {
                        seekPosition = Double(timemodel.currentTime)
                    } else {
                        onSeek(seekPosition)
                    }
                    isSeeking = editing
                }
            )
            Text(formatTime(Double(timemodel.totalTime)))
                .font(.caption.monospacedDigit())
        }
    }

    private func formatTime(_ seconds: Double) -> String {
        let total = max(0, Int(seconds))
        let h = total / 3600
        let m = total % 3600 / 60
        let s = total % 60
        if h > 0 {
            return String(format: "%d:%02d:%02d", h, m, s)
        }
        return String(format: "%02d:%02d", m, s)
    }
}
