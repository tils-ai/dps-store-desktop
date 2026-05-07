import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import type { TenantConfig } from "./config";

type ExitAction = "exit-fullscreen" | "quit";

let mainWindow: BrowserWindow | null = null;
let modalWindow: BrowserWindow | null = null;
let getTenant: () => TenantConfig | null = () => null;

let locked = false;
let sessionPassword: string | null = null;
let pendingExitAction: ExitAction | null = null;

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
    }
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
    }
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
