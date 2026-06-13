const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 窗口事件
  onWindowShown: (cb) => ipcRenderer.on('window-shown', cb),
  onWindowBlur: (cb) => ipcRenderer.on('window-blur', cb),
  onWindowWillHide: (cb) => ipcRenderer.on('window-will-hide', cb),
  onOpenConfig: (cb) => ipcRenderer.on('open-config', cb),
  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),

  // AI 整理
  organizeRequest: (payload) => ipcRenderer.invoke('organize-request', payload),

  // 配置
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),

  // 任务存储
  loadTasks: () => ipcRenderer.invoke('load-tasks'),
  saveTasks: (tasks) => ipcRenderer.invoke('save-tasks', tasks),
});
