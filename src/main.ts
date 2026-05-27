import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import type { PrinterConfig, TenantConfig } from "./config";
import { getPrinterConfig, hasConfig, loadConfig, resetConfig, saveConfig, updatePrinterConfig } from "./config";
import { installKiosk, type KioskController } from "./kiosk";
import { closePrinter, listPorts, sendBytes } from "./printer";
import { buildReceipt, sampleReceipt, type ReceiptData } from "./receipt";
import { resolveTenant, type ResolveData } from "./resolve";
import { buildTenantUrl } from "./url";
import { BASE_URL } from "./env";

const RENDERER_DIR = path.join(__dirname, "..", "renderer");

let mainWindow: BrowserWindow | null = null;
let kiosk: KioskController | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  kiosk = installKiosk({
    mainWindow,
    getTenantConfig: () => loadConfig(),
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("did-fail-load", (_event, _code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    console.error(`load failed: ${description} @ ${validatedURL}`);
    mainWindow?.loadFile(path.join(RENDERER_DIR, "error.html"));
  });

  if (!hasConfig()) {
    mainWindow.loadFile(path.join(RENDERER_DIR, "setup.html"));
  } else {
    const config = loadConfig();
    if (config) mainWindow.loadURL(buildTenantUrl(config));
  }
}

ipcMain.handle("tenant:resolve", (_event, tenantName: string) => {
  return resolveTenant(BASE_URL, tenantName);
});

ipcMain.handle("tenant:save", (_event, data: ResolveData) => {
  const cfg: TenantConfig = {
    id: data.id,
    tenantName: data.tenantName,
    brandName: data.brandName,
    domain: data.domain,
    baseUrl: BASE_URL,
    kiosk: false,
    installedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
  saveConfig(cfg);
  app.relaunch();
  app.exit(0);
});

ipcMain.handle("tenant:reset", () => {
  resetConfig();
  app.relaunch();
  app.exit(0);
});

ipcMain.handle("printer:get-config", () => getPrinterConfig());

ipcMain.handle("printer:set-config", (_e, patch: unknown) => {
  if (!patch || typeof patch !== "object") return { ok: false, error: "invalid patch" };
  const p = patch as Partial<PrinterConfig>;
  const cleaned: Partial<PrinterConfig> = {};
  if (typeof p.com === "string" && p.com.length > 0) cleaned.com = p.com;
  if (typeof p.baud === "number" && p.baud > 0) cleaned.baud = p.baud;
  if (typeof p.enabled === "boolean") cleaned.enabled = p.enabled;
  const next = updatePrinterConfig(cleaned);
  if (!next) return { ok: false, error: "no tenant config" };
  // 설정 변경 시 캐시된 포트 닫아 다음 호출에서 재오픈하도록
  closePrinter();
  return { ok: true, config: next };
});

ipcMain.handle("printer:list-ports", async () => {
  try {
    return { ok: true, ports: await listPorts() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("printer:print-receipt", async (_e, data: unknown) => {
  try {
    if (!data || typeof data !== "object") return { ok: false, error: "invalid receipt data" };
    const bytes = buildReceipt(data as ReceiptData);
    await sendBytes(bytes);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

async function printTestReceipt(): Promise<void> {
  if (!mainWindow) return;
  const tenant = loadConfig();
  const cfg = getPrinterConfig();
  if (!cfg.enabled) {
    await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "프린터 진단",
      message: "접수증 프린터가 비활성 상태입니다.",
      detail: `config.json의 printer.enabled를 true로 두고, com=${cfg.com} baud=${cfg.baud}이 정확한지 확인하세요.`,
    });
    return;
  }
  try {
    const bytes = buildReceipt(sampleReceipt(tenant?.brandName ?? "DPS Store"));
    await sendBytes(bytes);
  } catch (err) {
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "프린터 진단 실패",
      message: "테스트 출력 중 오류가 발생했습니다.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function confirmAndResetTenant(): Promise<void> {
  if (!mainWindow) return;
  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    buttons: ["취소", "초기화"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "테넌트 설정 초기화",
    message: "현재 테넌트 설정을 삭제하고 설치 화면으로 돌아갑니다.",
    detail: "저장된 config.json이 삭제되며 앱이 재시작됩니다. 계속하시겠습니까?",
  });
  if (result.response !== 1) return;
  resetConfig();
  app.relaunch();
  app.exit(0);
}

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register("Control+Shift+K", () => kiosk?.requestEnter());
  // 관리자 복구용 테넌트 초기화 단축키. 4키 조합으로 우발 입력 방지 + 확인 다이얼로그로 한 번 더 확인.
  // 키오스크 잠금 상태에서도 동작 — 잠금은 인메모리라 재시작 시 자연 해제됨.
  globalShortcut.register("Control+Shift+Alt+R", () => {
    confirmAndResetTenant().catch((err) => console.warn("reset confirm failed:", err));
  });
  // 진단용 — 샘플 접수증을 현재 설정의 프린터로 1장 출력. 단말 설치 후 인터페이스 점검에 사용.
  globalShortcut.register("Control+Shift+Alt+P", () => {
    printTestReceipt().catch((err) => console.warn("test print failed:", err));
  });
  // 패키지된 빌드에서만 동작. dev/unsigned macOS는 NoOp 또는 실패하나 무해.
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.warn("auto update check failed:", err);
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  closePrinter();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
