import { contextBridge, ipcRenderer } from "electron";
import type { ResolveData, ResolveResult } from "./resolve";

interface KioskAck {
  ok: boolean;
  error?: string;
}

const api = {
  resolveTenant: (tenantName: string): Promise<ResolveResult> =>
    ipcRenderer.invoke("tenant:resolve", tenantName),
  saveTenant: (data: ResolveData): Promise<void> => ipcRenderer.invoke("tenant:save", data),
  resetTenant: (): Promise<void> => ipcRenderer.invoke("tenant:reset"),
  kioskSetPassword: (password: string): Promise<KioskAck> =>
    ipcRenderer.invoke("kiosk:set-password", password),
  kioskTryUnlock: (value: string): Promise<KioskAck> => ipcRenderer.invoke("kiosk:try-unlock", value),
  kioskCancelModal: (): Promise<KioskAck> => ipcRenderer.invoke("kiosk:cancel-modal"),
};

contextBridge.exposeInMainWorld("electronAPI", api);

export type ElectronAPI = typeof api;
