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
  /** 전자서명 — "none": 무서명(기본), "pad": 승인 프로그램 서명창 */
  signMode?: "none" | "pad";
  /** 부가세 — "auto": KSnCAT 자동부가세 위임(기본), "explicit": 전문에 계산해 명시 */
  taxMode?: "auto" | "explicit";
  /** 관리자 원격 카드취소 허용 — 켜져 있으면 셸이 취소 요청 큐를 폴링한다 */
  remoteCancelEnabled?: boolean;
}

/**
 * 서버 카드단말 설정 조회.
 * - null: 서버가 정상 응답했지만 이 단말 설정이 없음 (미등록·미설정 — "비활성" 안내가 맞다)
 * - throw: 네트워크·타임아웃 오류 — 호출자가 "서버 연결 실패"로 구분해 안내한다
 */
export async function fetchTerminalServerConfig(
  baseUrl: string,
  tenantName: string,
): Promise<TerminalServerConfig | null> {
  const url = `${baseUrl}/api/terminal/config?tenant=${encodeURIComponent(tenantName)}`;
  const res = await net.fetch(url, { credentials: "include", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  return (await res.json()) as TerminalServerConfig;
}
