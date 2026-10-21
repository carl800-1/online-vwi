// 在线 VWI 发布系统 · 服务端桌面程序 preload
//
// 界面（public/ 下的管理页）本来是给浏览器用的，不该知道自己是跑在桌面程序里。
// 所以这里只暴露一小撮「程序级」能力，而且是有值判断的：
// 网页版打开时 window.vwiDesktop 根本不存在，界面代码走原路径即可，两边都能用。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vwiDesktop', {
  isDesktop: true,

  /** 版本、端口、数据目录、局域网地址等，界面顶栏展示用 */
  info: () => ipcRenderer.invoke('vwi:info'),

  /** 在资源管理器里打开数据目录 */
  openData: () => ipcRenderer.invoke('vwi:open-data'),

  /** 在资源管理器里定位日志文件 */
  openLog: () => ipcRenderer.invoke('vwi:open-log'),

  /** 开机自启开关，返回设置后的实际状态 */
  setAutoStart: (on) => ipcRenderer.invoke('vwi:auto-start', on),

  /** 收进托盘（和点 X 一样，服务继续跑） */
  hide: () => ipcRenderer.invoke('vwi:hide'),

  /** 真正退出，会断开所有终端 */
  quit: () => ipcRenderer.invoke('vwi:quit'),

  /** 服务端每 5 秒推一次状态，用于托盘与界面同步 */
  onState: (cb) => {
    const h = (_evt, state) => { try { cb(state); } catch { /* 界面出错不该连累主进程 */ } };
    ipcRenderer.on('vwi:state', h);
    return () => ipcRenderer.removeListener('vwi:state', h);
  }
});