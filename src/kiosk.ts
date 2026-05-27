import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import path from "node:path";
import type { TenantConfig } from "./config";

type ExitAction = "exit-fullscreen" | "quit";

let mainWindow: BrowserWindow | null = null;
let modalWindow: BrowserWindow | null = null;
let getTenant: () => TenantConfig | null = () => null;

let locked = false;
let sessionPassword: string | null = null;
let pendingExitAction: ExitAction | null = null;

/**
 * 잠금 모드에서 차단할 Windows 키 조합.
 * 단독 Meta(Win) 키는 OS가 시작 메뉴를 띄우는 시스템 키라 globalShortcut으로 차단 불가 —
 * 대신 blur 복귀로 보완. 아래 조합들은 등록 성공 시 OS 동작을 가로채 NoOp 처리한다.
 */
const META_COMBOS_TO_BLOCK = [
  "Super+R", // 실행
  "Super+E", // 탐색기
  "Super+D", // 바탕화면 보기
  "Super+S", // 검색
  "Super+I", // 설정
  "Super+L", // 잠금 화면 (일부 환경에서 OS가 우선)
  "Super+Tab", // 작업 보기
  "Super+Up",
  "Super+Down",
  "Super+Left",
  "Super+Right",
];

function registerLockShortcuts(): void {
  for (const accel of META_COMBOS_TO_BLOCK) {
    try {
      globalShortcut.register(accel, () => {
        /* 잠금 상태에서는 무시 — 시작 메뉴/실행창 등 OS 단축키 차단 */
      });
    } catch {
      // 일부 조합(Super+L 등)은 OS가 가로채 등록 실패 — 무시
    }
  }
}

function unregisterLockShortcuts(): void {
  for (const accel of META_COMBOS_TO_BLOCK) {
    try {
      globalShortcut.unregister(accel);
    } catch {
      // ignore
    }
  }
}

export interface KioskController {
  isLocked: () => boolean;
  requestEnter: () => void;
}

export function installKiosk(opts: {
  mainWindow: BrowserWindow;
  getTenantConfig: () => TenantConfig | null;
}): KioskController {
  mainWindow = opts.mainWindow;
  getTenant = opts.getTenantConfig;

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (!locked) return;

    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;

    if (key === "f12" || (ctrl && input.shift && key === "i")) {
      event.preventDefault();
      return;
    }
    if (ctrl && (key === "r")) {
      event.preventDefault();
      return;
    }

    if (key === "escape" || key === "f11") {
      event.preventDefault();
      openExitModal("exit-fullscreen");
      return;
    }
    if ((input.alt && key === "f4") || (ctrl && (key === "q" || key === "w"))) {
      event.preventDefault();
      openExitModal("quit");
      return;
    }
  });

  mainWindow.webContents.on("context-menu", (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // 잠금 상태에서 포커스를 잃으면(시작 메뉴/다른 창이 위로 올라옴) 즉시 우리 앱으로 복귀.
  // Win 키 단독 입력은 OS 시스템 키라 가로챌 수 없어 시작 메뉴 자체는 잠깐 뜰 수 있지만,
  // 곧바로 mainWindow를 다시 띄워 사용자가 OS로 빠져나가지 못하도록 한다.
  mainWindow.on("blur", () => {
    if (!locked || modalWindow) return; // 자체 모달 띄울 땐 정상 blur 허용
    try {
      if (mainWindow?.isMinimized()) mainWindow.restore();
      mainWindow?.setAlwaysOnTop(true);
      mainWindow?.focus();
      mainWindow?.moveTop();
    } catch {
      // ignore
    }
  });

  mainWindow.on("close", (event) => {
    if (locked) {
      event.preventDefault();
      openExitModal("quit");
    }
  });

  app.on("before-quit", (event) => {
    if (locked) {
      event.preventDefault();
      openExitModal("quit");
    }
  });

  ipcMain.handle("kiosk:set-password", (_e, password: unknown) => {
    if (typeof password !== "string" || password.length < 4) {
      return { ok: false, error: "비밀번호는 4자 이상이어야 합니다." };
    }
    sessionPassword = password;
    locked = true;
    if (mainWindow) {
      mainWindow.setKiosk(true);
      mainWindow.setFullScreen(true);
      mainWindow.setClosable(false);
      mainWindow.setAlwaysOnTop(true);
    }
    registerLockShortcuts();
    closeModal();
    return { ok: true };
  });

  ipcMain.handle("kiosk:try-unlock", (_e, value: unknown) => {
    if (!locked) return { ok: true };
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, error: "값을 입력해주세요." };
    }
    const tenant = getTenant();
    const matches = value === sessionPassword || (tenant !== null && value === tenant.tenantName);
    if (!matches) {
      return { ok: false, error: "비밀번호 또는 스토어 ID가 일치하지 않습니다." };
    }
    const action = pendingExitAction ?? "exit-fullscreen";
    locked = false;
    sessionPassword = null;
    pendingExitAction = null;
    if (mainWindow) {
      mainWindow.setKiosk(false);
      mainWindow.setFullScreen(false);
      mainWindow.setClosable(true);
      mainWindow.setAlwaysOnTop(false);
    }
    unregisterLockShortcuts();
    closeModal();
    if (action === "quit") app.quit();
    return { ok: true };
  });

  ipcMain.handle("kiosk:cancel-modal", () => {
    // 진입/해제 모달 모두 취소 가능 — 잠금 상태는 유지됨
    pendingExitAction = null;
    closeModal();
    return { ok: true };
  });

  return {
    isLocked: () => locked,
    requestEnter: () => {
      if (locked || modalWindow) return;
      openModal("kiosk-enter.html");
    },
  };
}

function openExitModal(action: ExitAction) {
  if (!modalWindow) {
    pendingExitAction = action;
    openModal("kiosk-exit.html");
    return;
  }
  if (action === "quit") pendingExitAction = "quit";
  modalWindow.focus();
}

function openModal(file: "kiosk-enter.html" | "kiosk-exit.html") {
  if (!mainWindow) return;
  if (modalWindow) {
    modalWindow.focus();
    return;
  }
  modalWindow = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    width: 420,
    height: 260,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  modalWindow.setMenuBarVisibility(false);
  modalWindow.on("closed", () => {
    modalWindow = null;
  });
  modalWindow.loadFile(path.join(__dirname, "..", "renderer", file));
}

function closeModal() {
  if (modalWindow) {
    modalWindow.close();
    modalWindow = null;
  }
}
