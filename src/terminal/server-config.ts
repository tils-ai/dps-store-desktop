import { net } from "electron";

// 서버(웹 관리자)에서 관리하는 카드단말 설정 — 어댑터가 승인 전문에 사용한다.
// 단말 식별은 브라우저 세션의 단말 쿠키(httpOnly)로 하므로 credentials 포함이 필수다.

export interface TerminalServerConfig {
  enabled: boolean;
  provider: string;
  platform: string;
  /** 가맹점 번호 (매장당 1개) */
  mid: string;
  /** 단말기 번호 (리더기당 1개) — 비어 있으면 이 단말은 리더기 미연결 */
  tid: string;
  terminalName: string;
}

export async function fetchTerminalServerConfig(
  baseUrl: string,
  tenantName: string,
): Promise<TerminalServerConfig | null> {
  try {
    const url = `${baseUrl}/api/terminal/config?tenant=${encodeURIComponent(tenantName)}`;
    const res = await net.fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as TerminalServerConfig;
  } catch {
    return null;
  }
}
