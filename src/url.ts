import type { TenantConfig } from "./config";

export function buildTenantUrl(cfg: TenantConfig): string {
  if (cfg.domain) return `https://${cfg.domain}`;
  return `${cfg.baseUrl}/${cfg.tenantName}`;
}
