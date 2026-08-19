import { createMockAdapter } from "./mock-adapter";
import type { TerminalAdapter } from "./types";

export type { TerminalAdapter } from "./types";
export type {
  TerminalApproveRequest,
  TerminalApproveResult,
  TerminalCancelResult,
  TerminalTradeStatus,
} from "./types";

/**
 * 카드단말 어댑터 선택
 *
 * 어댑터가 null 이면 preload 가 window.terminal 을 노출하지 않고,
 * 웹은 기존 결제 흐름(직원 처리)으로 동작한다. 어댑터 없이 브리지만 노출하면
 * 웹이 리더기 결제를 시도하다 실패 화면에 갇히므로 반드시 함께 게이트한다.
 *
 * - Mock: `DPS_TERMINAL_MOCK=1` 환경변수로 실행한 경우만 (개발/시연 전용, 실 결제 아님)
 * - VAN 모듈 연동 어댑터: 추후 추가 (연동 자료 수령 후)
 */
export function createTerminalAdapter(): TerminalAdapter | null {
  if (process.env.DPS_TERMINAL_MOCK === "1") {
    console.warn("[terminal] MOCK adapter enabled — approvals are fake, not real payments");
    return createMockAdapter();
  }

  return null;
}
