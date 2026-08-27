# AetherVR Player

**没有 VR 眼镜，也能看 VR 视频。**

VR 视频本质上只是全景画面——AetherVR Player 把 VR / 360° / SBS 分屏视频直接搬进浏览器：用鼠标拖动（手机上用手指）旋转视角、滚轮或双指捏合缩放，像在现场一样"转头看"，全程不需要任何头显设备。

**在线体验 Demo：<https://pipipiper.github.io/AetherVR-Player/>**（纯静态版，打开即用，本地文件不上传）

## 为什么用它

- 🥽 **免眼镜看 VR**：加载视频后默认进入 VR / 360° 沉浸视图，拖动即转头；也可一键切回普通平面模式
- 📁 **本地视频零上传**：文件只在浏览器里读取，点击选择或直接拖进页面即可，隐私无忧
- 🔗 **在线直链即点即播**：粘贴 http(s) 视频地址回车就播；内置跨域代理，没有 CORS 头的视频站也能在 VR（WebGL 纹理）模式下播放
- 📼 **SBS 左右分屏支持**：自动识别超宽画幅（宽高比 > 2.5），提供 仅左眼 / 仅右眼 / 左右分屏 三种模式
- 📃 **播放列表**：多选文件或整个文件夹自动生成列表（自动排除 50MB 以下小文件），上一集 / 下一集、播完自动连播；兼容 PotPlayer 的 **.dpl 播放列表**（自动识别 UTF-8 / GBK）
- 📱 **手机也能看 8K**：iPhone / 安卓解不动 8K HEVC 时，可一键让服务器 ffmpeg 实时转成 4K H.264 流（可拖进度）；桌面端则直接硬解
- 🖥️ **Windows / macOS 桌面版**：除网页版全部能力外，还支持 DPL 列表直读磁盘、多播放列表管理、收藏夹与播放位置记忆
- ✨ **纯净无广告**，零依赖，一个 `server.js` + 一个 `index.html` 就是全部

## 快速开始

### 网页版（自托管完整版）

只需要本机装有 Node.js 18 或更高版本：

```bash
npm run dev          # 或：node server.js
```

然后浏览器打开 <http://localhost:7100/>。指定地址端口：`node server.js --host 127.0.0.1 --port 8080`。

#### 反向代理与特殊来源端口

通过 Caddy、Nginx 等反向代理对外提供服务时，建议让 Node 服务只监听回环地址，并显式启用可信代理模式：

```bash
node server.js --host 127.0.0.1 --port 7100 --trust-proxy
```

`--trust-proxy` 会使用反向代理传来的 `X-Forwarded-For` 识别客户端，用于转码会话归属和限流。只有当服务端口不直接暴露到公网、请求必须经过你控制的代理时才应启用。

公网版默认只允许代理 HTTP/HTTPS 标准端口 `80`、`443`。如需播放其他非标准端口的可信来源，可按 `域名:端口` 设置部署环境自己的白名单：

```bash
AETHERVR_ALLOWED_HOSTPORT=media.example.com:19766,video.example.com:9443 node server.js --host 127.0.0.1 --port 7100 --trust-proxy
```

不要把内网地址加入公网服务的来源白名单；DNS 解析到回环、私网或保留地址的目标仍会被 SSRF 防护拒绝。

转码与媒体预检需要系统安装 `ffmpeg` 和 `ffprobe`。程序会先从 `PATH` 查找，也可显式指定路径；编码器和线程数均可按部署机器能力配置：

```bash
FFMPEG=/usr/local/bin/ffmpeg \
FFPROBE=/usr/local/bin/ffprobe \
AETHERVR_VIDEO_ENCODER=libx264 \
AETHERVR_TRANSCODE_THREADS=8 \
node server.js --host 127.0.0.1 --port 7100
```

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FFMPEG` / `FFPROBE` | 自动查找 | 可执行文件名或绝对路径 |
| `AETHERVR_ALLOWED_HOSTPORT` | 空 | 允许访问的非标准来源端口，逗号分隔的 `域名:端口` |
| `AETHERVR_VIDEO_ENCODER` | `auto` | `auto`、`libx264` 或 `h264_videotoolbox`；自动模式仅在可用的 macOS 上选择 VideoToolbox |
| `AETHERVR_TRANSCODE_THREADS` | ffmpeg 自动决定 | `libx264` 的线程数（1–256）；通常无需设置 |

### GitHub Pages 静态版

<https://pipipiper.github.io/AetherVR-Player/> 打开即用。Pages 只有静态托管，因此支持本地文件、文件夹、DPL 与 VR 播放，但不含代理 / 转码后端——在线视频与 8K 转码请用自托管完整版或桌面版。

### 桌面版（Windows / macOS）

到 [Releases](https://github.com/pipipiper/AetherVR-Player/releases) 下载安装包（Windows 为 NSIS 安装包，macOS 为 Universal DMG，同时支持 Intel 和 Apple Silicon）。

桌面版在网页版之上额外提供：

- **DPL 直读磁盘**：dpl 里的本地绝对路径由系统直接查磁盘，存在即可流式播放（可拖进度），无需浏览器逐个授权
- **多播放列表管理**：右侧抽屉页签，每个列表就是一个 .dpl 文件（PotPlayer 可直接打开），新建 / 打开 / 批量新增 / 批量删除，改动自动写回，重启自动恢复全部页签
- **收藏夹 + 位置记忆**：固定在最左页签；收藏或加入列表时可记录当前播放位置，条目显示「▶ 位置」标记，下次点击从该位置续播（含转码中的远程 8K 视频）；收藏夹同样支持导入 / 导出 dpl 与批量添加、批量删除
- **导入 / 导出**：随时另存为 dpl；导出的 `position` 自定义字段会被 PotPlayer 忽略，兼容性不受影响

本地开发运行桌面版：

```bash
npm install        # 首次，安装 electron
npm run desktop    # 启动桌面窗口
npm run dist       # 打包安装包到 dist/
```

## 使用说明

| 操作 | 说明 |
| --- | --- |
| 播放本地视频 | 中央面板点「打开本地文件 / 打开文件夹」，或把文件（可多选）拖进页面 |
| 播放在线视频 | 粘贴视频直链 →「播放链接」/ 回车 |
| 转动 VR 视角 | 鼠标拖动（手机单指拖动）旋转，滚轮（双指捏合）缩放 |
| 切换视图 | 顶栏「普通模式」/「VR / 360」 |
| 导入 dpl 列表 | 把 PotPlayer 的 .dpl 文件拖进页面；在线条目直接可播，本地条目点一下单独授权，或「添加媒体目录」自动匹配 |
| 播放列表 | 控制栏「列表」图标打开面板；⏮ / ⏭ 切换上下集，播完自动连播 |
| 快捷键 | 空格 = 播放 / 暂停 |

## 浏览器兼容性

| 浏览器 | 说明 |
| --- | --- |
| Safari | 推荐，HEVC / H.265 支持最好 |
| Safari (iPhone / iPad) | 已适配移动端，视频内联播放不跳系统播放器；配合服务器转码可看 8K |
| Chrome / Edge | H.264 + AAC 完美支持；HEVC 大多无法解码时会提示转码 |
| Firefox | 同 Chrome |

## 工作原理

- **VR 渲染**：Three.js（已内置于 `vendor/`）把 `<video>` 画面贴到 360° 球体内部，相机随拖动旋转——这就是"不用眼镜看 VR"的全部秘密
- **在线代理**：`server.js` 内置 `/proxy?url=<地址>`，转发 Range 头（进度条可拖）、自动跟随 302 跳转、修正 MIME；页面上的跨域链接自动改走代理，使用无感知
- **服务器转码**：检测到设备解不动（如手机上的 8K HEVC）时，可一键由服务器 ffmpeg 转成 4K H.264 HLS 流；macOS 在编码器可用时自动用 VideoToolbox 硬加速，其他系统默认使用 libx264，空闲 2 分钟自动停止
- **桌面版**：内嵌同一个 `server.js`（仅监听 127.0.0.1），本地文件通过 `--local-fs` 开启的 `/local` 接口流式读取

## 已知限制

- **iPhone / iPad 打开 SMB 网络位置的文件**：iOS「文件」App 会先把整个文件复制到 Safari 沙盒才交给网页，几十 GB 的视频会在后台无声下载很久。建议先下载到「我的 iPhone」，或改用在线直链 + 服务器转码
- **网盘签名直链**（115、阿里云盘等）通常绑定生成时的 IP / 登录态，换网络环境会报 `invalid signature`，需重新复制链接
- 自托管后端目前每个进程同时只保留一个实时转码会话，适合个人或单用户部署；多人并发转码需要独立的任务队列和资源调度
- Windows 播放 HEVC 需系统安装「HEVC 视频扩展」；macOS 原生支持
- 有声视频首次播放可能被浏览器自动播放策略拦截，点一下播放键即可

## 自动发版

推送 `v*` 格式标签后，GitHub Actions 自动构建 macOS Universal DMG/ZIP、Windows x64 安装包，创建 GitHub Release，并将静态网页版发布到 GitHub Pages。

## 技术栈

- 零运行时 npm 依赖的 Node.js 18+ 后端（`server.js`：静态服务 + 代理 + 转码调度；转码另需系统 ffmpeg）
- 原生 HTML5 `<video>` + WebGL（Three.js），无任何构建步骤
- Electron（桌面版，Windows / macOS）

## 隐私

所有处理都在本机完成：本地文件不会上传到任何服务器；在线链接只经过你自己的代理转发。

## License

[GNU AGPL-3.0](LICENSE) —— 最严格的著佐权（copyleft）许可证：任何人使用、修改、分发本项目，甚至**仅将其部署在服务器上对外提供网络服务**，都必须以相同许可证公开完整源代码；希望闭源商用需另行取得作者授权。
