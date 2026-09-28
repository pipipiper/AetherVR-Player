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
    var startPosition: TimeInterval = 0
    var mode: VRDisplayMode = .vr360
    /// WebDAV 等需要认证头时传入（如 ["Authorization": "Basic ..."]）
    var httpHeaders: [String: String] = [:]

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
    /// 软/硬解与投影模式：切换会重建播放器，rebuildToken 驱动 .id/.task
    @State private var hardwareDecode = true
    @State private var modeOverride: VRDisplayMode?
    /// 重建播放器时恢复到的进度
    @State private var resumeTime: TimeInterval?

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
            KSVideoPlayer(coordinator: coordinator, url: url, options: options)
                .id(rebuildToken)
                .ignoresSafeArea()
                .onTapGesture {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        showControls.toggle()
                    }
                    if showControls { scheduleAutoHide() }
                }
                .gesture(
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
            if showControls {
                controlsOverlay
                    .transition(.opacity)
            }
            if playerState == .buffering || playerState == .initialized {
                ProgressView()
                    .tint(.white)
                    .scaleEffect(1.3)
                    .allowsHitTesting(false)
            }
        }
        .statusBarHidden(true)
        .task(id: rebuildToken) {
            // 播放器每次重建（软硬解/模式切换）后重新挂回调（dismantle 时会清空）
            coordinator.onStateChanged = { _, state in
                playerState = state
            }
            coordinator.onFinish = { _, error in
                if error == nil { dismiss() }
            }
        }
        .onAppear {
            gyroEnabled = false
            KSOptions.enableSensor = false
            coordinator.isMaskShow = false
            scheduleAutoHide()
        }
        .onDisappear {
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
        }
    }

    /// 切换软硬解/投影模式：先停掉旧播放器（防止后台继续解码），记录进度后重建
    private func rebuildPlayer(_ change: () -> Void) {
        coordinator.playerLayer?.stop()
        resumeTime = Double(coordinator.timemodel.currentTime)
        change()
        scheduleAutoHide()
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
