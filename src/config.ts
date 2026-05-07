import Store from "electron-store";

export interface TenantConfig {
  id: string;
  tenantName: string;
  brandName: string;
  domain: string | null;
  baseUrl: string;
  kiosk: boolean;
  installedAt: string;
  schemaVersion: 1;
}

interface Schema {
  tenant?: TenantConfig;
}

const store = new Store<Schema>({ name: "config" });

export function loadConfig(): TenantConfig | null {
  return store.get("tenant") ?? null;
}

export function saveConfig(cfg: TenantConfig): void {
  store.set("tenant", cfg);
}

export function resetConfig(): void {
  store.delete("tenant");
}

export function hasConfig(): boolean {
  return Boolean(store.get("tenant"));
}
