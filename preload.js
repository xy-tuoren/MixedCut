const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mixedCutApi", {
  pickSourceFolder: () => ipcRenderer.invoke("pick-source-folder"),
  pickOutputFolder: () => ipcRenderer.invoke("pick-output-folder"),
  getSubfolders: (sourceDir) => ipcRenderer.invoke("get-subfolders", sourceDir),
  getSourceStats: (sourceDir) => ipcRenderer.invoke("get-source-stats", sourceDir),
  listAdbDevices: () => ipcRenderer.invoke("list-adb-devices"),
  startMix: (payload) => ipcRenderer.invoke("start-mix", payload)
});
