const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 窗口事件
  onWindowShown: (cb) => ipcRenderer.on('window-shown', cb),
  onWindowBlur: (cb) => ipcRenderer.on('window-blur', cb),
  onWindowWillHide: (cb) => ipcRenderer.on('window-will-hide', cb),
  onAppBeforeQuit: (cb) => ipcRenderer.on('app-before-quit', cb),
  onOpenConfig: (cb) => ipcRenderer.on('open-config', cb),
  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),

  // AI 整理
  organizeRequest: (payload) => ipcRenderer.invoke('organize-request', payload),

  // 配置
  getConfig: () => ipcRenderer.invoke('get-config'),
  hasApiKey: () => ipcRenderer.invoke('has-api-key'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  setSettingsOpen: (open) => ipcRenderer.invoke('set-settings-open', open),
  getLoginSettings: () => ipcRenderer.invoke('get-login-settings'),
  setLoginSettings: (enabled) => ipcRenderer.invoke('set-login-settings', enabled),
  rendererReadyToQuit: (saved) => ipcRenderer.send('renderer-ready-to-quit', saved),

  // 任务存储
  loadTasks: () => ipcRenderer.invoke('load-tasks'),
  saveTasks: (tasks) => ipcRenderer.invoke('save-tasks', tasks),
  listTasksFiles: () => ipcRenderer.invoke('list-tasks-files'),
  loadTasksByDate: (dateStr) => ipcRenderer.invoke('load-tasks-by-date', dateStr),
  saveTasksByDate: (dateStr, tasks) => ipcRenderer.invoke('save-tasks-by-date', dateStr, tasks),

  // 窗口位置
  setWindowFixed: (fixed) => ipcRenderer.invoke('set-window-fixed', fixed),

  // 页面切换
  setPage: (page) => ipcRenderer.invoke('set-page', page),
  getPage: () => ipcRenderer.invoke('get-page'),

  // 笔记操作
  listNotes: () => ipcRenderer.invoke('list-notes'),
  getPinnedNotes: () => ipcRenderer.invoke('get-pinned-notes'),
  togglePinNote: (filename) => ipcRenderer.invoke('toggle-pin-note', filename),
  readNote: (filename) => ipcRenderer.invoke('read-note', filename),
  saveNote: (filename, content) => ipcRenderer.invoke('save-note', filename, content),
  createNote: () => ipcRenderer.invoke('create-note'),
  renameNote: (oldName, newName) => ipcRenderer.invoke('rename-note', oldName, newName),
  deleteNote: (filename) => ipcRenderer.invoke('delete-note', filename),
  aiNameNote: (filename, content) => ipcRenderer.invoke('ai-name-note', filename, content),
  saveNoteImage: (dataUrl) => ipcRenderer.invoke('save-note-image', dataUrl),
  readNoteImage: (relativePath) => ipcRenderer.invoke('read-note-image', relativePath),
  openNoteImage: (relativePath) => ipcRenderer.invoke('open-note-image', relativePath),
  deleteNoteImage: (relativePath) => ipcRenderer.invoke('delete-note-image', relativePath),

  // 日报
  generateDailyReport: (tasks) => ipcRenderer.invoke('generate-daily-report', tasks),

  // 翻译
  translateRequest: (payload) => ipcRenderer.invoke('translate', payload),

  // DeepSeek Harness
  harnessSnapshot: () => ipcRenderer.invoke('harness-snapshot'),
  harnessListSessions: () => ipcRenderer.invoke('harness-list-sessions'),
  harnessLoadSession: (sessionId) => ipcRenderer.invoke('harness-load-session', sessionId),
  harnessSelectWorkspace: () => ipcRenderer.invoke('harness-select-workspace'),
  harnessUpdateOptions: (payload) => ipcRenderer.invoke('harness-update-options', payload),
  harnessStart: (payload) => ipcRenderer.invoke('harness-start', payload),
  harnessStop: () => ipcRenderer.invoke('harness-stop'),
  harnessNewSession: () => ipcRenderer.invoke('harness-new-session'),
  harnessResetWorkspaceApproval: () => ipcRenderer.invoke('harness-reset-workspace-approval'),
  harnessOpenWeb: () => ipcRenderer.invoke('harness-open-web'),
  onHarnessEvent: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('harness:event', handler);
    return () => ipcRenderer.removeListener('harness:event', handler);
  },
});
