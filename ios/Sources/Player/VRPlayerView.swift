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

/// 播放器：裸 KSVideoPlayer + 自绘控制层。
/// 支持播放列表上下文（列表内切换/自动连播/进度回写）、倍速、收藏、
/// 双指缩放 FOV、拖动调视角、陀螺仪、软硬解切换。
struct VRPlayerView: View {
    let url: URL
    let title: String
    var startPosition: TimeInterval
    var mode: VRDisplayMode
    /// WebDAV 等需要认证头时传入（如 ["Authorization": "Basic ..."]）
    var httpHeaders: [String: String]

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var playlistStore: PlaylistStore
    @StateObject private var coordinator = KSVideoPlayer.Coordinator()
    @State private var gyroEnabled = false
    @State private var showControls = true
    @State private var showQueueSheet = false
    @State private var playerState: KSPlayerState = .initialized
    @State private var isSeeking = false
    @State private var seekPosition: Double = 0
    @State private var hideControlsTask: DispatchWorkItem?
    @State private var baseFov: Float = .pi / 3
    @State private var yawBase: Float = 0
    @State private var pitchBase: Float = 0
    @State private var hardwareDecode: Bool
    @State private var modeOverride: VRDisplayMode?
    @State private var resumeTime: TimeInterval?
    @State private var playerVisible = true
    @State private var currentIndex: Int
    @State private var playbackRate: Float = 1.0
    @State private var isFavorite = false
    @State private var useResumeTime = false
    /// 播完连播时跳过重建流程里的进度保存（避免把末尾进度写回去）
    @State private var skipNextSave = false
    /// 播放队列（播放中可整体替换，如从单集切到某个列表）
    @State private var queue: [PlaylistItem]

    init(url: URL, title: String, startPosition: TimeInterval = 0,
         mode: VRDisplayMode = .vr360, httpHeaders: [String: String] = [:],
         hardwareDecode: Bool? = nil,
         queue: [PlaylistItem] = [], queueIndex: Int = 0) {
        self.url = url
        self.title = title
        self.startPosition = startPosition
        self.mode = mode
        self.httpHeaders = httpHeaders
        let defaults = UserDefaults.standard
        _hardwareDecode = State(
            initialValue: hardwareDecode ?? defaults.bool(forKey: SettingsKeys.defaultHardwareDecode)
        )
        _currentIndex = State(initialValue: queueIndex)
        _queue = State(initialValue: queue)
    }

    // MARK: - 当前播放项

    private var hasQueue: Bool { !queue.isEmpty && queue.indices.contains(currentIndex) }

    private var currentItem: PlaylistItem? {
        hasQueue ? queue[currentIndex] : nil
    }

    private var currentURL: URL {
        if let item = currentItem, let u = URL(string: item.file) { return u }
        return url
    }

    private var currentTitle: String {
        if let item = currentItem, !item.title.isEmpty { return item.title }
        return title
    }

    private var rememberPosition: Bool {
        UserDefaults.standard.bool(forKey: SettingsKeys.rememberPosition)
    }

    private var effectiveStart: TimeInterval {
        if useResumeTime, let resumeTime { return resumeTime }
        if let item = currentItem, rememberPosition, item.position > 0 {
            return TimeInterval(item.position)
        }
        return startPosition
    }

    private var effectiveMode: VRDisplayMode { modeOverride ?? mode }
    private var rebuildToken: String { "\(hardwareDecode)-\(effectiveMode.rawValue)-\(currentURL.absoluteString)" }

    private var options: KSOptions {
        let options = KSOptions()
        options.display = effectiveMode.displayEnum
        options.startPlayTime = effectiveStart
        options.hardwareDecode = hardwareDecode
        // 默认 false 时 MEPlayer 用 FFmpeg 软解，8K 直接卡成幻灯片；
        // 打开后走 VideoToolbox 硬解（DecompressionSession），不支持的编码会自动回退软解
        options.asynchronousDecompression = true
        options.isSecondOpen = true
        options.startPlayRate = playbackRate
        if !httpHeaders.isEmpty {
            options.appendHeader(httpHeaders)
        }
        return options
    }

    // MARK: - 界面

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if playerVisible {
                KSVideoPlayer(coordinator: coordinator, url: currentURL, options: options)
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
            gyroEnabled = UserDefaults.standard.bool(forKey: SettingsKeys.gyroDefaultOn)
            KSOptions.enableSensor = gyroEnabled
            if !gyroEnabled {
                KSOptions.vrYaw = 0
                KSOptions.vrPitch = 0
                yawBase = 0
                pitchBase = 0
            }
            isFavorite = playlistStore.favorites.items.contains { $0.file == currentURL.absoluteString }
            coordinator.isMaskShow = false
            scheduleAutoHide()
        }
        .onDisappear {
            savePosition()
            KSOptions.vrYaw = nil
            KSOptions.vrPitch = nil
            coordinator.resetPlayer()
        }
        .sheet(isPresented: $showQueueSheet) {
            queueSheet
        }
        .onChange(of: showQueueSheet) { _, presented in
            // 弹层打开时暂停 8K 无帧重绘，避免 GPU 被占满导致列表滑动卡顿
            KSOptions.vrPauseRerender = presented
        }
    }

    private var controlsOverlay: some View {
        VStack {
            // 顶部：返回、标题、播放列表、180°/360° 切换、陀螺仪
            HStack(spacing: 10) {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.left")
                        .font(.body)
                        .frame(width: 36, height: 36)
                }
                Text(currentTitle)
                    .font(.caption)
                    .lineLimit(1)
                Spacer()
                Button {
                    showQueueSheet = true
                } label: {
                    Label(
                        hasQueue ? "\(currentIndex + 1)/\(queue.count)" : "列表",
                        systemImage: "list.bullet"
                    )
                    .font(.footnote)
                    .padding(.horizontal, 10)
                    .frame(height: 32)
                    .background(.white.opacity(0.15), in: Capsule())
                }
                modeSegment
                if effectiveMode != .plane {
                    Button {
                        gyroEnabled.toggle()
                        KSOptions.enableSensor = gyroEnabled
                        if gyroEnabled {
                            KSOptions.vrYaw = nil
                            KSOptions.vrPitch = nil
                        } else {
                            KSOptions.vrYaw = 0
                            KSOptions.vrPitch = 0
                            yawBase = 0
                            pitchBase = 0
                        }
                        scheduleAutoHide()
                    } label: {
                        Image(systemName: "gyroscope")
                            .font(.body)
                            .frame(width: 36, height: 36)
                            .opacity(gyroEnabled ? 1 : 0.45)
                    }
                }
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.black.opacity(0.45))

            Spacer()

            // 底部：播放/暂停 + 进度条
            HStack(spacing: 10) {
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
                        .frame(width: 40, height: 40)
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
            .padding(.vertical, 8)
            .background(.black.opacity(0.45))
        }
        .overlay(alignment: .trailing) {
            // 右侧竖排按钮列：倍速 / 软硬解 / 收藏 / 更多投影
            VStack(spacing: 12) {
                sideButton(text: formatRate(playbackRate)) {
                    cycleRate()
                }
                sideButton(text: hardwareDecode ? "硬解" : "软解") {
                    rebuildPlayer { hardwareDecode.toggle() }
                }
                Button {
                    toggleFavorite()
                } label: {
                    Image(systemName: isFavorite ? "star.fill" : "star")
                        .font(.body)
                        .foregroundStyle(isFavorite ? .yellow : .white)
                        .frame(width: 40, height: 40)
                        .background(.black.opacity(0.45), in: Circle())
                }
                Menu {
                    Button("平面") { rebuildPlayer { modeOverride = .plane } }
                    Button("VR 眼镜分屏") { rebuildPlayer { modeOverride = .vrBox } }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.body)
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(.black.opacity(0.45), in: Circle())
                }
            }
            .padding(.trailing, 12)
        }
    }

    /// 180°/360° 主切换（平面/VR眼镜在右侧 ⋯ 二级菜单里）
    private var modeSegment: some View {
        HStack(spacing: 0) {
            ForEach([VRDisplayMode.vr180, .vr360]) { m in
                Button {
                    if effectiveMode != m {
                        rebuildPlayer { modeOverride = m }
                    }
                } label: {
                    Text(m.rawValue)
                        .font(.footnote.weight(.medium))
                        .frame(width: 46, height: 32)
                        .background(
                            effectiveMode == m ? Color.accentColor : Color.white.opacity(0.15),
                            in: Rectangle()
                        )
                }
            }
        }
        .foregroundStyle(.white)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func sideButton(text: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.white)
                .frame(minWidth: 40, minHeight: 40)
                .padding(.horizontal, 8)
                .background(.black.opacity(0.45), in: Capsule())
        }
    }

    private static let rateOrder: [Float] = [1.0, 1.25, 1.5, 2.0, 0.5, 0.75]

    private func cycleRate() {
        let idx = Self.rateOrder.firstIndex(of: playbackRate) ?? 0
        let next = Self.rateOrder[(idx + 1) % Self.rateOrder.count]
        playbackRate = next
        coordinator.playbackRate = next
        scheduleAutoHide()
    }

    /// 播放列表弹层：页签浏览全部列表（左右滑动切换），当前播放条目高亮
    private var queueSheet: some View {
        InPlayerPlaylistView(currentItemID: currentItem?.id) { playlist, index in
            showQueueSheet = false
            playFromBrowser(playlist: playlist, index: index)
        }
        .presentationDetents([.medium, .large])
    }

    /// 从列表弹层选片：把整个列表设为队列并起播
    private func playFromBrowser(playlist: Playlist, index: Int) {
        guard playlist.items.indices.contains(index) else { return }
        rebuildPlayer {
            useResumeTime = false
            queue = playlist.items
            currentIndex = index
        }
    }

    // MARK: - 行为

    private func formatRate(_ rate: Float) -> String {
        rate == Float(Int(rate)) ? "\(Int(rate)).0x" : String(format: "%.2gx", rate)
    }

    private func attachCallbacks() {
        coordinator.onStateChanged = { _, state in
            playerState = state
        }
        coordinator.onFinish = { _, error in
            if error != nil { return }
            // 播完：清掉本集记忆位置，自动连播下一集（跳过重建时的再次保存）
            savePosition(reset: true)
            skipNextSave = true
            if UserDefaults.standard.bool(forKey: SettingsKeys.autoPlayNext),
               hasQueue, currentIndex + 1 < queue.count {
                switchTo(currentIndex + 1)
            } else {
                dismiss()
            }
        }
    }

    /// 切换软硬解/投影模式/列表项：先停旧播放器并卸载播放视图，
    /// 给异步关停让出时间后再重建，避免新旧解码管线并存
    private func rebuildPlayer(_ change: () -> Void) {
        if !skipNextSave { savePosition() }
        skipNextSave = false
        resumeTime = Double(coordinator.timemodel.currentTime)
        useResumeTime = true
        coordinator.playerLayer?.stop()
        playerVisible = false
        change()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            attachCallbacks()
            playerVisible = true
            scheduleAutoHide()
        }
    }

    /// 列表内切集（不保留进度，从该集记忆位置起播）
    private func switchTo(_ index: Int) {
        guard queue.indices.contains(index), index != currentIndex || !playerVisible else {
            showQueueSheet = false
            return
        }
        showQueueSheet = false
        rebuildPlayer {
            useResumeTime = false
            currentIndex = index
        }
    }

    /// 进度回写到播放列表（reset=true 表示已播完，清掉记忆位置）
    private func savePosition(reset: Bool = false) {
        guard rememberPosition, let item = currentItem else { return }
        let seconds = reset ? 0 : Int(coordinator.timemodel.currentTime)
        guard reset || seconds > 0 else { return }
        for playlist in playlistStore.tabs {
            if let idx = playlist.items.firstIndex(where: { $0.id == item.id }) {
                playlist.items[idx].position = seconds
                try? playlistStore.save(playlist)
                return
            }
        }
    }

    private func toggleFavorite() {
        isFavorite.toggle()
        if isFavorite {
            let item = currentItem ?? PlaylistItem(
                file: currentURL.absoluteString,
                title: currentTitle,
                position: Int(coordinator.timemodel.currentTime)
            )
            playlistStore.favorites.items.append(item)
        } else {
            playlistStore.favorites.items.removeAll { $0.file == currentURL.absoluteString }
        }
        try? playlistStore.save(playlistStore.favorites)
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
