const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('box', {
  state: () => ipcRenderer.invoke('state'),
  list: (tab) => ipcRenderer.invoke('list', tab),
  open: (p) => ipcRenderer.invoke('open', p),
  pathOf: (file) => webUtils.getPathForFile(file),
  drop: (paths, tab, before) => ipcRenderer.invoke('drop', paths, tab, before),
  switchTab: (i) => ipcRenderer.invoke('switch-tab', i),
  renameBox: (name) => ipcRenderer.invoke('rename-box', name),
  renameTab: (i, name) => ipcRenderer.invoke('rename-tab', i, name),
  toggleCollapse: () => ipcRenderer.invoke('toggle-collapse'),
  toggleLock: () => ipcRenderer.invoke('toggle-lock'),
  toggleView: () => ipcRenderer.invoke('toggle-view'),
  itemMenu: (paths) => ipcRenderer.invoke('item-menu', paths),
  trash: (paths) => ipcRenderer.invoke('trash', paths),
  startDrag: (paths, icon) => ipcRenderer.invoke('start-drag', paths, icon), // resolves once the drop is done
  boxMenu: () => ipcRenderer.invoke('box-menu'),
  onChange: (fn) => ipcRenderer.on('changed', fn),
})
