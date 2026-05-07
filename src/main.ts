import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { hasConfig, loadConfig, resetConfig, saveConfig, TenantConfig } from "./config";
import { applyKioskLockdown } from "./kiosk";
import { resolveTenant, ResolveData } from "./resolve";
import { buildTenantUrl } from "./url";
import { BASE_URL } from "./env";

const RENDERER_DIR = path.join(__dirname, "..", "renderer");

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const config = loadConfig();
  const kiosk = config?.kiosk ?? false;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: kiosk,
    kiosk,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (kiosk && mainWindow) applyKioskLockdown(mainWindow);

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
  } else if (config) {
    mainWindow.loadURL(buildTenantUrl(config));
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

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
