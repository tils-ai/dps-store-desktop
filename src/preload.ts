import { contextBridge, ipcRenderer } from "electron";
import type { PrinterConfig } from "./config";
import type { ReceiptData } from "./receipt";
import type { ResolveData, ResolveResult } from "./resolve";
import type {
  TerminalAdapter,
  TerminalApproveRequest,
  TerminalApproveResult,
  TerminalCancelResult,
  TerminalTradeStatus,
} from "./terminal/types";

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

// 카드단말(VAN 직결) 브리지 — main 에 어댑터가 있을 때만 노출한다.
// 웹은 window.terminal 존재 여부로 연동 리더기 결제 가능을 판별하므로,
// 어댑터 없이 노출하면 결제 실패 화면에 갇힌다.
const terminalAvailable = ipcRenderer.sendSync("terminal:available") === true;

if (terminalAvailable) {
  const terminal: TerminalAdapter = {
    approve: (req: TerminalApproveRequest): Promise<TerminalApproveResult> =>
      ipcRenderer.invoke("terminal:approve", req),
    cancel: (pgCno: string, reason: string): Promise<TerminalCancelResult> =>
      ipcRenderer.invoke("terminal:cancel", pgCno, reason),
    inquire: (pgCno: string): Promise<TerminalTradeStatus> => ipcRenderer.invoke("terminal:inquire", pgCno),
    reverseLast: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("terminal:reverse-last"),
    ping: (): Promise<{ connected: boolean; firmware?: string }> => ipcRenderer.invoke("terminal:ping"),
  };
  contextBridge.exposeInMainWorld("terminal", terminal);
}

export type ElectronAPI = typeof api;
