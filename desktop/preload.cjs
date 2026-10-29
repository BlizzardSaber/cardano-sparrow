const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cardanoCamera", {
  requestPermission: () => ipcRenderer.invoke("camera:request-permission"),
});
