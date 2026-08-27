/* VR 播放器 —— Electron 主进程（Windows / macOS）
 *
 * 架构：主进程内嵌启动 server.js（随机空闲端口，仅监听 127.0.0.1，
 * 开启 --local-fs 本地文件流式接口），渲染层加载 http://127.0.0.1:<port>/，
 * 因此代理、编码探测、服务器转码等能力与网页版完全一致。
 *
 * 通过 preload 暴露 window.vrDesktop：
 *   - openDpl()          弹出系统对话框选 .dpl，返回 { name, data(base64) }
 *   - checkPaths(paths)  批量检查磁盘路径是否存在，返回 { path: { exists, size } }
 *   - platform           process.platform
 */
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// localStorage 按源（http://127.0.0.1:<port>）隔离：端口必须固定，
// 否则每次启动都是新源，收藏夹/播放列表持久化会丢。被占用时才退回随机端口。
const PREFERRED_PORT = 17395;
function canListen(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

let mainWindow = null;

async function start() {
  const port = (await canListen(PREFERRED_PORT)) ? PREFERRED_PORT : await findFreePort();
  // server.js 从 process.argv 解析 --host/--port/--local-fs，require 即启动监听
  process.argv = [process.execPath, 'server.js',
    '--host', '127.0.0.1', '--port', String(port), '--local-fs'];
  require(path.join(__dirname, '..', 'server.js'));

  ipcMain.handle('dpl:open', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '打开 DPL 播放列表',
      properties: ['openFile'],
      filters: [{ name: 'DPL 播放列表', extensions: ['dpl'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const file = r.filePaths[0];
    return { name: path.basename(file), data: fs.readFileSync(file).toString('base64') };
  });

  // 导出 dpl：系统保存对话框 + 写文件，返回保存路径（取消返回 null）
  ipcMain.handle('dpl:save', async (event, payload) => {
    const { name, data } = payload || {};
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出 DPL 播放列表',
      defaultPath: name || '播放列表.dpl',
      filters: [{ name: 'DPL 播放列表', extensions: ['dpl'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, Buffer.from(String(data || ''), 'base64'));
    return r.filePath;
  });

  // 批量选择本地视频：返回 [{ path, name, size }]
  ipcMain.handle('files:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择视频文件（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: '视频文件',
        extensions: ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'ts', 'm2ts', 'flv', 'wmv', '3gp', 'ogv', 'ogg'],
      }],
    });
    if (r.canceled) return [];
    return r.filePaths.map((p) => {
      let size = 0;
      try { size = fs.statSync(p).size; } catch { /* 忽略读取失败的条目 */ }
      return { path: p, name: path.basename(p), size };
    });
  });

  ipcMain.handle('fs:check', (event, paths) => {
    const out = {};
    const list = (Array.isArray(paths) ? paths : []).slice(0, 5000);
    for (const p of list) {
      if (typeof p !== 'string' || !p) continue;
      try {
        const st = fs.statSync(p);
        out[p] = { exists: st.isFile(), size: st.size };
      } catch {
        out[p] = { exists: false, size: 0 };
      }
    }
    return out;
  });

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f4f5f7',
    autoHideMenuBar: true,
    title: 'VR 播放器',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());
