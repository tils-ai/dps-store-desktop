import { contextBridge, ipcRenderer } from "electron";
import type { ResolveResult, ResolveData } from "./resolve";

const api = {
  resolveTenant: (tenantName: string): Promise<ResolveResult> =>
    ipcRenderer.invoke("tenant:resolve", tenantName),
  saveTenant: (data: ResolveData): Promise<void> =>
    ipcRenderer.invoke("tenant:save", data),
  resetTenant: (): Promise<void> => ipcRenderer.invoke("tenant:reset"),
};

contextBridge.exposeInMainWorld("electronAPI", api);

export type ElectronAPI = typeof api;
