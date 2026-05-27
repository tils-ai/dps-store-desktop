import { contextBridge, ipcRenderer } from "electron";
import type { PrinterConfig } from "./config";
import type { ReceiptData } from "./receipt";
import type { ResolveData, ResolveResult } from "./resolve";

interface KioskAck {
  ok: boolean;
  error?: string;
}

interface PrinterAck {
  ok: boolean;
  error?: string;
}

interface PrinterConfigAck extends PrinterAck {
  config?: PrinterConfig;
}

interface PrinterListAck extends PrinterAck {
  ports?: { path: string; manufacturer?: string }[];
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
  // 키오스크 접수증 프린터 — 정책 ON + 단말 enabled 시에만 실제 출력
  getPrinterConfig: (): Promise<PrinterConfig> => ipcRenderer.invoke("printer:get-config"),
  setPrinterConfig: (patch: Partial<PrinterConfig>): Promise<PrinterConfigAck> =>
    ipcRenderer.invoke("printer:set-config", patch),
  listPrinterPorts: (): Promise<PrinterListAck> => ipcRenderer.invoke("printer:list-ports"),
  printReceipt: (data: ReceiptData): Promise<PrinterAck> =>
    ipcRenderer.invoke("printer:print-receipt", data),
};

contextBridge.exposeInMainWorld("electronAPI", api);

export type ElectronAPI = typeof api;
