const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("billAPI", {
  explain: (payload) => ipcRenderer.invoke("explain-bill", payload),
  extractInsurancePlan: (payload) => ipcRenderer.invoke("extract-insurance-plan", payload)
});
