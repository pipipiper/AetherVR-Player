import SwiftUI

/// 播放记录页：最近播放在前，点按续播，可单条删除/全部清空
struct HistoryView: View {
    @EnvironmentObject private var historyStore: PlaybackHistoryStore
    @State private var playback: URLPlaySheet.PlaybackTarget?
    @State private var showClearConfirm = false

    var body: some View {
        NavigationStack {
            Group {
                if historyStore.records.isEmpty {
                    ContentUnavailableView("暂无播放记录", systemImage: "clock")
                } else {
                    List(historyStore.records) { record in
                        Button {
                            play(record)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(record.title)
                                        .font(.subheadline)
                                        .lineLimit(2)
                                    Text(record.url)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                    HStack(spacing: 8) {
                                        if record.duration > 0 {
                                            Text("看到 \(formatTime(record.position)) / \(formatTime(record.duration))")
                                        } else {
                                            Text("看到 \(formatTime(record.position))")
                                        }
                                        Text(record.updatedAt.formatted(date: .numeric, time: .shortened))
                                    }
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if record.duration > 0 {
                                    let progress = min(max(Double(record.position) / Double(record.duration), 0), 1)
                                    Text("\(Int(progress * 100))%")
                                        .font(.caption2.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .foregroundStyle(.primary)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                historyStore.remove(record)
                            } label: {
                                Label("删除", systemImage: "trash")
                            }
                        }
                    }
                }
            }
            .navigationTitle("播放记录")
            .toolbar {
                if !historyStore.records.isEmpty {
                    ToolbarItem(placement: .primaryAction) {
                        Button("清空") { showClearConfirm = true }
                    }
                }
            }
            .confirmationDialog("清空全部播放记录？", isPresented: $showClearConfirm, titleVisibility: .visible) {
                Button("清空", role: .destructive) { historyStore.removeAll() }
                Button("取消", role: .cancel) {}
            }
            .fullScreenCover(item: $playback) { target in
                VRPlayerView(
                    url: target.url,
                    title: target.title,
                    startPosition: target.position,
                    mode: target.mode,
                    httpHeaders: target.headers,
                    hardwareDecode: target.hardwareDecode,
                    queue: target.queue,
                    queueIndex: target.queueIndex
                )
            }
        }
    }

    private func play(_ record: PlaybackRecord) {
        guard let url = URLLiteral.http(record.url) ?? URL(string: record.url) else { return }
        let item = PlaylistItem(file: record.url, title: record.title, position: record.position)
        playback = URLPlaySheet.PlaybackTarget(
            url: url,
            title: record.title,
            mode: VRDisplayMode(rawValue: UserDefaults.standard.string(forKey: SettingsKeys.defaultProjection) ?? "") ?? .vr360,
            position: TimeInterval(record.position),
            queue: [item],
            queueIndex: 0
        )
    }

    private func formatTime(_ seconds: Int) -> String {
        let h = seconds / 3600
        let m = seconds % 3600 / 60
        let s = seconds % 60
        if h > 0 {
            return String(format: "%d:%02d:%02d", h, m, s)
        }
        return String(format: "%02d:%02d", m, s)
    }
}
