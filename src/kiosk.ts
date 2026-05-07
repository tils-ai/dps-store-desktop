import { BrowserWindow } from "electron";

export function applyKioskLockdown(win: BrowserWindow): void {
  win.setMenuBarVisibility(false);
  win.setAutoHideMenuBar(true);

  win.webContents.on("before-input-event", (event, input) => {
    const k = input.key;
    const ctrl = input.control || input.meta;
    if (k === "F12") return event.preventDefault();
    if (ctrl && input.shift && (k === "I" || k === "i")) return event.preventDefault();
    if (k === "F11") return event.preventDefault();
    if (ctrl && (k === "r" || k === "R")) return event.preventDefault();
    if (ctrl && (k === "w" || k === "W")) return event.preventDefault();
  });

  win.webContents.on("context-menu", (e) => e.preventDefault());

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}
