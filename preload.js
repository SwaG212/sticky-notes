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

  // 页面切换
  setPage: (page) => ipcRenderer.invoke('set-page', page),

  // 笔记操作
  listNotes: () => ipcRenderer.invoke('list-notes'),
  readNote: (filename) => ipcRenderer.invoke('read-note', filename),
  saveNote: (filename, content) => ipcRenderer.invoke('save-note', filename, content),
  createNote: () => ipcRenderer.invoke('create-note'),
  renameNote: (oldName, newName) => ipcRenderer.invoke('rename-note', oldName, newName),
  deleteNote: (filename) => ipcRenderer.invoke('delete-note', filename),
  aiNameNote: (filename, content) => ipcRenderer.invoke('ai-name-note', filename, content),
});
