# AetherVR Player iOS

免头显 VR/360° 视频播放器的 iOS 原生版（iPhone / iPad，iOS 17+）。

播放内核基于 [KSPlayer](https://github.com/kingslay/KSPlayer)（GPL，FFmpeg + VideoToolbox 硬解 + Metal 渲染），SMB 基于 [AMSMB2](https://github.com/amosavian/AMSMB2)。本目录代码与仓库整体一样以 AGPL-3.0 开源。

## 构建准备

1. 安装 Xcode（27.0+），首次启动接受协议并登录 Apple ID（免费账号即可）
2. 安装 XcodeGen（任选其一）：
   - `brew install xcodegen`（macOS 过新无 bottle 时）改用官方预编译包：
     `curl -sL https://github.com/yonaskolb/XcodeGen/releases/latest/download/xcodegen.zip | bsdtar -xf - -C /tmp` 后使用 `/tmp/xcodegen/bin/xcodegen`
3. 生成本地签名配置（不进 git）：

   ```bash
   cd ios
   cp LocalSigning.xcconfig.example LocalSigning.xcconfig
   # 编辑填入自己的 DEVELOPMENT_TEAM（Apple 开发者账号的 Team ID）
   ```

4. 生成工程并打开：

   ```bash
   xcodegen
   open AetherVR.xcodeproj
   ```

## 命令行构建

```bash
cd ios
xcodegen
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project AetherVR.xcodeproj -scheme AetherVR \
  -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<你的TeamID> \
  build
```

## 安装到真机（自签侧载）

- 免费 Apple ID：Xcode 直接 Run 到设备，7 天过期后需重新安装
- 想长期用：[SideStore](https://sidestore.io) 自动续签
- 首次运行在设备上 设置 → 通用 → VPN与设备管理 中信任开发者证书

## 目录结构

```
Sources/
├── App/        # SwiftUI 入口与首页
├── Player/     # 播放内核：球面渲染、陀螺仪、手势（M1）
├── Sources/    # 片源：SMB / WebDAV / 本地 / 直链（M2）
├── Playlist/   # dpl 播放列表、收藏夹（M3）
└── UI/         # 界面组件（M4）
```
