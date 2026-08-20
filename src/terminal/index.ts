import { createKsnetAdapter } from "./ksnet/adapter";
import { createMockAdapter } from "./mock-adapter";
import type { TerminalServerConfig } from "./server-config";
import type { TerminalAdapter } from "./types";

export type { TerminalAdapter } from "./types";
export type {
  TerminalApproveRequest,
  TerminalApproveResult,
  TerminalCancelOriginal,
  TerminalCancelResult,
  TerminalTradeStatus,
} from "./types";
export { fetchTerminalServerConfig, type TerminalServerConfig } from "./server-config";

/** VAN 어댑터가 승인 시점에 서버 설정(MID/TID)을 받아가는 통로 + 로컬 데몬 접속 정보 */
export interface TerminalAdapterDeps {
  getServerConfig: () => Promise<TerminalServerConfig | null>;
  /** 로컬 승인 데몬(KSnCAT) 접속 정보 — port 0 이면 미설정 */
  local: { host: string; port: number; signMode?: "X" | "K" | "T" | " "; taxMode?: "kscat" | "explicit" };
  /** 키오스크 연동 모드 결제창 부모 윈도우 핸들 (Windows HWND 십진수 문자열) */
  getWindowHandle?: () => string | null;
}

/**
 * 카드단말 어댑터 선택
 *
 * 어댑터가 null 이면 preload 가 window.terminal 을 노출하지 않고,
 * 웹은 기존 결제 흐름(직원 처리)으로 동작한다. 어댑터 없이 브리지만 노출하면
 * 웹이 리더기 결제를 시도하다 실패 화면에 갇히므로 반드시 함께 게이트한다.
 *
 * - Mock: `DPS_TERMINAL_MOCK=1` 환경변수로 실행한 경우만 (개발/시연 전용, 실 결제 아님)
 * - KSNET(KSnCAT): 단말 config 의 terminal.port (또는 `DPS_TERMINAL_PORT` 환경변수) 설정 시.
 *   KSnCAT 앱 설정의 "인터페이스 포트"와 같은 값이어야 한다.
 */
export function createTerminalAdapter(deps: TerminalAdapterDeps): TerminalAdapter | null {
  if (process.env.DPS_TERMINAL_MOCK === "1") {
    console.warn("[terminal] MOCK adapter enabled — approvals are fake, not real payments");
    return createMockAdapter();
  }

  const envPort = Number(process.env.DPS_TERMINAL_PORT ?? 0);
  const port = envPort > 0 ? envPort : deps.local.port;
  if (port > 0) {
    console.log(`[terminal] KSNET adapter enabled — KSnCAT ${deps.local.host}:${port}`);
    return createKsnetAdapter({
      host: deps.local.host,
      port,
      getServerConfig: deps.getServerConfig,
      signMode: deps.local.signMode,
      taxMode: deps.local.taxMode,
      getWindowHandle: deps.getWindowHandle,
    });
  }

  return null;
}
