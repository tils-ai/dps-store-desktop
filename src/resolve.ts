export interface ResolveData {
  id: string;
  tenantName: string;
  brandName: string;
  domain: string | null;
}

export type ResolveResult =
  | { ok: true; status: number; data: ResolveData }
  | { ok: false; status: number; error: string };

export async function resolveTenant(baseUrl: string, tenantName: string): Promise<ResolveResult> {
  try {
    const res = await fetch(`${baseUrl}/api/tenants/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantName }),
    });

    const text = await res.text();
    let json: { error?: string } & Partial<ResolveData> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }

    if (res.ok && json.id && json.tenantName && json.brandName !== undefined) {
      return {
        ok: true,
        status: res.status,
        data: {
          id: json.id,
          tenantName: json.tenantName,
          brandName: json.brandName,
          domain: json.domain ?? null,
        },
      };
    }

    return { ok: false, status: res.status, error: json.error ?? `HTTP ${res.status}` };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Network error";
    return { ok: false, status: 0, error: message };
  }
}
