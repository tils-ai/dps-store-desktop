import { app, BrowserWindow, dialog, globalShortcut, ipcMain, session, shell } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import type { PrinterConfig, TenantConfig } from "./config";
import {
  getPrinterConfig,
  getTerminalConfig,
  hasConfig,
  loadConfig,
  resetConfig,
  saveConfig,
  updatePrinterConfig,
} from "./config";
import { installKiosk, type KioskController } from "./kiosk";
import { closePrinter, listPorts, sendBytes, warmUpPrinter } from "./printer";
import { buildReceipt, sampleReceipt, type ReceiptData } from "./receipt";
import { resolveTenant, type ResolveData } from "./resolve";
import {
  createTerminalAdapter,
  fetchTerminalServerConfig,
  type TerminalApproveRequest,
  type TerminalCancelOriginal,
} from "./terminal";
import { startTerminalHeartbeat } from "./terminal/heartbeat";
import { buildTenantUrl } from "./url";
import { BASE_URL } from "./env";

const RENDERER_DIR = path.join(__dirname, "..", "renderer");

let mainWindow: BrowserWindow | null = null;
let kiosk: KioskController | null = null;

// jarvis 에디터(PHP)의 정적 CSS/JS는 Cache-Control 없이 Last-Modified만 있어
// Chromium 휴리스틱 캐싱((now-LastModified)*10%)에 걸린다. Last-Modified가 수년 전이라
// 한 번 캐시되면 수개월간 재검증 없이 stale본이 쓰인다. no-store override는 네트워크
// 응답에만 걸려, 캐시 히트(네트워크 미발생)인 기존 항목은 못 지우므로 부팅 시
// clearCache로 한 번 비워야 한다(아래 whenReady 참고).
// dps-store 본체 에셋은 빌드ID로 URL 버전이 바뀌므로 영향 없음.
function disableJarvisCache(): void {
  session.defaultSession.webRequest.onHeadersReceived({ urls: ["https://jarvis.wepnp.com/*"] }, (details, callback) => {
    const headers: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(details.responseHeaders ?? {})) {
      const lower = key.toLowerCase();
      if (lower === "cache-control" || lower === "expires" || lower === "pragma") continue;
      headers[key] = value;
    }
    headers["cache-control"] = ["no-store"];
    callback({ responseHeaders: headers });
  });
}

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

// 카드단말(VAN 직결) — 어댑터가 있을 때만 preload 가 window.terminal 을 노출한다.
// 승인/취소는 예외를 그대로 던져 renderer 쪽에서 실패 UI 로 처리하게 한다.
// MID/TID 는 서버(웹 관리자)가 진실 소스 — 어댑터가 승인 시점마다 조회한다.
const terminalAdapter = createTerminalAdapter({
  getServerConfig: () => {
    const cfg = loadConfig();
    if (!cfg) return Promise.resolve(null);
    return fetchTerminalServerConfig(cfg.baseUrl, cfg.tenantName);
  },
  local: getTerminalConfig(),
  getWindowHandle: () => {
    // 키오스크 연동 모드(암호화 여부 "K")의 SW 모델번호 = 결제창 부모 윈도우 핸들.
    // HWND LE 버퍼 → 부호 없는 십진수 문자열 가정 — 형식·필요 여부는 실기 확인.
    if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed()) return null;
    return mainWindow.getNativeWindowHandle().readUInt32LE(0).toString();
  },
});

ipcMain.on("terminal:available", (event) => {
  event.returnValue = Boolean(terminalAdapter);
});

// 카드단말 하트비트 — 어댑터가 있을 때만 (관리자 카드단말 탭 상태 표시용)
if (terminalAdapter) {
  startTerminalHeartbeat({
    adapter: terminalAdapter,
    getTarget: () => {
      const cfg = loadConfig();
      return cfg ? { baseUrl: cfg.baseUrl, tenantName: cfg.tenantName } : null;
    },
  });
}

function requireTerminal() {
  if (!terminalAdapter) throw new Error("card terminal adapter not available");
  return terminalAdapter;
}

ipcMain.handle("terminal:approve", (_e, req: TerminalApproveRequest) => requireTerminal().approve(req));
ipcMain.handle("terminal:cancel", (_e, pgCno: string, reason: string, original?: TerminalCancelOriginal) =>
  requireTerminal().cancel(pgCno, reason, original),
);
ipcMain.handle("terminal:inquire", (_e, pgCno: string) => requireTerminal().inquire(pgCno));
ipcMain.handle("terminal:reverse-last", () => requireTerminal().reverseLast());
ipcMain.handle("terminal:ping", () => requireTerminal().ping());

/** 카드단말 진단 다이얼로그 — 어댑터 상태 + 서버 설정(MID/TID) 확인. 현장 설치 점검용 */
async function showTerminalDiagnostics(): Promise<void> {
  if (!mainWindow) return;

  let adapterLine = "어댑터 없음 — window.terminal 미노출 (VAN 모듈 연동 전 정상)";
  if (terminalAdapter) {
    const label = process.env.DPS_TERMINAL_MOCK === "1" ? "MOCK (실 결제 아님)" : "VAN";
    try {
      const ping = await terminalAdapter.ping();
      adapterLine = `어댑터: ${label} · 리더기 연결: ${ping.connected ? "정상" : "끊김"}${
        ping.firmware ? ` · fw ${ping.firmware}` : ""
      }`;
    } catch (err) {
      adapterLine = `어댑터: ${label} · 응답 실패: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const cfg = loadConfig();
  const serverCfg = cfg ? await fetchTerminalServerConfig(cfg.baseUrl, cfg.tenantName) : null;
  const serverLines = serverCfg
    ? [
        `사용: ${serverCfg.enabled ? "ON" : "OFF"} · 사업자: ${serverCfg.provider}`,
        `MID: ${serverCfg.mid || "(미입력)"} · TID: ${serverCfg.tid || "(미입력)"}`,
        `단말 이름: ${serverCfg.terminalName || "-"}`,
      ]
    : ["서버 설정 조회 실패 — 이 단말이 주문 단말로 등록되어 있는지 확인하세요."];

  await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "카드단말 진단",
    message: adapterLine,
    detail: serverLines.join("\n"),
  });
}

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

async function chooseAndEnablePort(): Promise<boolean> {
  if (!mainWindow) return false;
  let ports: { path: string; manufacturer?: string }[] = [];
  try {
    ports = await listPorts();
  } catch {
    /* ignore — 빈 목록으로 진행 */
  }
  const cfg = getPrinterConfig();
  if (ports.length === 0) {
    await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "프린터 진단",
      message: "감지된 시리얼 포트가 없습니다.",
      detail: "프린터 전원/USB 연결을 확인하고 다시 시도해주세요.",
    });
    return false;
  }
  const portButtons = ports.map((p) => (p.manufacturer ? `${p.path} (${p.manufacturer})` : p.path));
  const buttons = [...portButtons, "취소"];
  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "프린터 진단 — COM 포트 선택",
    message: "출력에 사용할 COM 포트를 선택하세요.",
    detail: `현재 설정: com=${cfg.com}, baud=${cfg.baud}. 선택한 포트로 자동 활성화됩니다.`,
    buttons,
    defaultId: Math.max(
      0,
      ports.findIndex((p) => p.path === cfg.com)
    ),
    cancelId: buttons.length - 1,
    noLink: true,
  });
  if (result.response === buttons.length - 1) return false;
  const selected = ports[result.response]?.path;
  if (!selected) return false;
  updatePrinterConfig({ com: selected, enabled: true });
  closePrinter(); // 캐시된 포트 닫고 다음 호출에서 재오픈
  return true;
}

async function printTestReceipt(): Promise<void> {
  if (!mainWindow) return;
  const tenant = loadConfig();
  const cfg = getPrinterConfig();

  // 비활성 상태면 활성화/포트선택 다이얼로그 먼저
  if (!cfg.enabled) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: "question",
      title: "프린터 진단",
      message: "접수증 프린터가 비활성 상태입니다.",
      detail: `현재 설정: com=${cfg.com}, baud=${cfg.baud}. 이 설정으로 활성화하고 출력하시겠습니까?`,
      buttons: ["활성화 후 출력", "포트 변경...", "취소"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (result.response === 2) return;
    if (result.response === 0) {
      updatePrinterConfig({ enabled: true });
      closePrinter();
    } else if (result.response === 1) {
      const picked = await chooseAndEnablePort();
      if (!picked) return;
    }
  }

  try {
    const bytes = buildReceipt(sampleReceipt(tenant?.brandName ?? "DPS Store"));
    await sendBytes(bytes);
    const next = getPrinterConfig();
    await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "프린터 진단",
      message: "샘플 접수증을 송신했습니다.",
      detail: `${next.com} / ${next.baud}bps — 종이가 안 나오면 프린터 전원/용지를 확인하세요.`,
    });
  } catch (err) {
    const next = getPrinterConfig();
    const result = await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "프린터 진단 실패",
      message: "테스트 출력 중 오류가 발생했습니다.",
      detail: `${next.com} / ${next.baud}bps\n${err instanceof Error ? err.message : String(err)}`,
      buttons: ["포트 변경...", "닫기"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) {
      const picked = await chooseAndEnablePort();
      if (picked) await printTestReceipt(); // 재시도
    }
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

app.whenReady().then(async () => {
  disableJarvisCache();
  // 이미 디스크 캐시에 박힌 휴리스틱 stale 항목 evict — 이후 no-store가 재캐싱 차단.
  await session.defaultSession.clearCache();
  createWindow();
  // 부팅 시 프린터 자가복구 — 일체형 단말 재실행 후 자동 출력이 안 되는 문제 방지.
  // 운영자가 진단 단축키를 누르지 않아도 설정된 포트를 자동으로 열고 enabled를 복구한다.
  // 비동기·비차단: 실패해도 로그만 남기고 부팅 흐름을 막지 않는다(다이얼로그 없음).
  warmUpPrinter()
    .then((r) => {
      if (r.skipped) return;
      if (r.ok) console.log(`printer warmup ok: ${r.com} (enabled)`);
      else console.warn(`printer warmup failed: ${r.com ?? "?"} — ${r.error}`);
    })
    .catch((err) => console.warn("printer warmup error:", err));
  globalShortcut.register("Control+Shift+K", () => kiosk?.requestEnter());
  // 새로고침 — 캐시를 무시하는 하드 리로드(메인 프레임 + jarvis iframe 포함).
  // 외부 리소스가 stale일 때 재시작 없이 즉시 갱신하는 운영자용 단축키.
  globalShortcut.register("Control+Shift+R", () => {
    mainWindow?.webContents.reloadIgnoringCache();
  });
  // 관리자 복구용 테넌트 초기화 단축키. 4키 조합으로 우발 입력 방지 + 확인 다이얼로그로 한 번 더 확인.
  // 키오스크 잠금 상태에서도 동작 — 잠금은 인메모리라 재시작 시 자연 해제됨.
  globalShortcut.register("Control+Shift+Alt+R", () => {
    confirmAndResetTenant().catch((err) => console.warn("reset confirm failed:", err));
  });
  // 진단용 — 샘플 접수증을 현재 설정의 프린터로 1장 출력. 단말 설치 후 인터페이스 점검에 사용.
  globalShortcut.register("Control+Shift+Alt+P", () => {
    printTestReceipt().catch((err) => console.warn("test print failed:", err));
  });
  // 진단용 — 카드단말 어댑터 상태 + 서버 설정(MID/TID) 확인. 리더기 설치 점검에 사용.
  globalShortcut.register("Control+Shift+Alt+T", () => {
    showTerminalDiagnostics().catch((err) => console.warn("terminal diagnostics failed:", err));
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
