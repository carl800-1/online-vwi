// 预加载桥：渲染层唯一能看到的外部能力。
// 只暴露必要的几个方法，不给 require、不给文件系统、不给任意 ipc 通道。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vwi', {
  isTerminal: true,

  // 启动时取一次初始状态（含冷启动的本地内容清单）
  snapshot: () => ipcRenderer.invoke('vwi:snapshot'),

  // 翻转完成回报：ok=false 时主进程会保留旧画面、不删旧文件
  flipped: (payload) => ipcRenderer.send('vwi:flipped', payload),

  // 主进程 → 渲染层
  onView: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('vwi:view', h);
    return () => ipcRenderer.removeListener('vwi:view', h);
  },
  onStatus: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('vwi:status', h);
    return () => ipcRenderer.removeListener('vwi:status', h);
  },
  // 1.8.0：管理端改派下发，播放页挂一条 4 秒提示（画面自己换了内容，得让人知道是管理端干的）
  onAssign: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('vwi:assign', h);
    return () => ipcRenderer.removeListener('vwi:assign', h);
  },

  log: (level, msg) => ipcRenderer.send('vwi:log', { level, msg }),

  // 设置页用
  probe: (server) => ipcRenderer.invoke('vwi:probe', server),
  lineProcesses: (server, lineId) => ipcRenderer.invoke('vwi:line-processes', { server, lineId }),
  saveConfig: (input) => ipcRenderer.invoke('vwi:save-config', input),
  finishSetup: () => ipcRenderer.invoke('vwi:finish-setup'),
  openContentDir: () => ipcRenderer.invoke('vwi:open-content-dir'),
  openLog: () => ipcRenderer.invoke('vwi:open-log'),
  cacheStats: () => ipcRenderer.invoke('vwi:cache-stats'),
  quit: () => ipcRenderer.invoke('vwi:quit')
});
