'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 最小权限 IPC 桥（文档 17 节）：
 * 只暴露具体方法，禁止暴露原始 ipcRenderer。
 */
contextBridge.exposeInMainWorld('assistantAPI', {
  startText(text) {
    return ipcRenderer.invoke('assistant:start', text);
  },
  sendResponse(text) {
    return ipcRenderer.invoke('assistant:response', text);
  },
  stop(source) {
    return ipcRenderer.invoke('assistant:stop', source);
  },
  pause() {
    return ipcRenderer.invoke('assistant:pause');
  },
  resume() {
    return ipcRenderer.invoke('assistant:resume');
  },
  getSnapshot() {
    return ipcRenderer.invoke('assistant:snapshot');
  },
  getConfig() {
    return ipcRenderer.invoke('assistant:config');
  },
  /**
   * 订阅助手事件。
   * @param {(event: string, payload: object) => void} cb
   * @returns {() => void} 注销函数
   */
  onEvent(cb) {
    const listener = (_event, message) => cb(message.event, message.payload);
    ipcRenderer.on('assistant:event', listener);
    return () => ipcRenderer.removeListener('assistant:event', listener);
  },
});
