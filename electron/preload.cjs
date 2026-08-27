/* VR 播放器 —— Electron 预加载脚本
 * 仅暴露最小桌面能力给渲染层（contextIsolation 开启，页面拿不到 Node）。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vrDesktop', {
  openDpl: () => ipcRenderer.invoke('dpl:open'),
  checkPaths: (paths) => ipcRenderer.invoke('fs:check', paths),
  platform: process.platform,
});
