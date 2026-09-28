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

/// 播放器封装：裸 KSVideoPlayer（无自带控制层，避免亮度/音量拖动手势
/// 和球面视角拖动打架）+ 自绘控制层。
/// 陀螺仪默认关闭，手动拖动调视角；右上角可打开陀螺仪跟随。
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

    private var options: KSOptions {
        let options = KSOptions()
        options.display = mode.displayEnum
        options.startPlayTime = startPosition
        options.hardwareDecode = true
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
                .onTapGesture {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        showControls.toggle()
                    }
                    if showControls { scheduleAutoHide() }
                }
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
        .onAppear {
            gyroEnabled = false
            KSOptions.enableSensor = false
            coordinator.isMaskShow = false
            coordinator.onStateChanged = { _, state in
                playerState = state
            }
            coordinator.onFinish = { _, error in
                if error == nil { dismiss() }
            }
            scheduleAutoHide()
        }
        .onDisappear {
            coordinator.resetPlayer()
        }
    }

    private var controlsOverlay: some View {
        VStack {
            // 顶部：返回、标题、陀螺仪开关
            HStack(spacing: 12) {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.left")
                        .font(.headline)
                        .frame(width: 36, height: 36)
                }
                Text(title)
                    .font(.subheadline)
                    .lineLimit(1)
                Spacer()
                if mode != .plane {
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
