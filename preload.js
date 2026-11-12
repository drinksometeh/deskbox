const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('box', {
  state: () => ipcRenderer.invoke('state'),
  list: (tab) => ipcRenderer.invoke('list', tab),
  open: (p) => ipcRenderer.invoke('open', p),
  drop: (files, tab) => ipcRenderer.invoke('drop', files.map((f) => webUtils.getPathForFile(f)), tab),
  switchTab: (i) => ipcRenderer.invoke('switch-tab', i),
  renameBox: (name) => ipcRenderer.invoke('rename-box', name),
  renameTab: (i, name) => ipcRenderer.invoke('rename-tab', i, name),
  toggleCollapse: () => ipcRenderer.invoke('toggle-collapse'),
  toggleLock: () => ipcRenderer.invoke('toggle-lock'),
  toggleView: () => ipcRenderer.invoke('toggle-view'),
  itemMenu: (paths) => ipcRenderer.invoke('item-menu', paths),
  trash: (paths) => ipcRenderer.invoke('trash', paths),
  startDrag: (paths, icon) => ipcRenderer.send('start-drag', paths, icon),
  boxMenu: () => ipcRenderer.invoke('box-menu'),
  onChange: (fn) => ipcRenderer.on('changed', fn),
})
