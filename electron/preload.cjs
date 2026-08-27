/* VR 播放器 —— Electron 预加载脚本
 * 仅暴露最小桌面能力给渲染层（contextIsolation 开启，页面拿不到 Node）。 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('vrDesktop', {
  openDpl: () => ipcRenderer.invoke('dpl:open'),
  saveDpl: (name, data) => ipcRenderer.invoke('dpl:save', { name, data }),
  pickVideos: () => ipcRenderer.invoke('files:pick'),
  checkPaths: (paths) => ipcRenderer.invoke('fs:check', paths),
  // File 对象 → 磁盘绝对路径（Electron webUtils；拿不到时返回空串）
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
  platform: process.platform,
});
