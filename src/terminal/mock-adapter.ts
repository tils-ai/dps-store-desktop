import type {
  TerminalAdapter,
  TerminalApproveRequest,
  TerminalApproveResult,
  TerminalCancelResult,
  TerminalTradeStatus,
} from "./types";

// 개발/시연용 Mock 어댑터 — 실 리더기 없이 승인 흐름을 검증한다.
// DPS_TERMINAL_MOCK=1 로 실행할 때만 활성화된다 (index.ts).
// 실 결제가 아니므로 운영 단말에서 절대 켜지 않는다.

const MOCK_MID = "MOCK000001";
const MOCK_TID = "DPT0MOCK01";
const APPROVE_DELAY_MS = 1500;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMockAdapter(): TerminalAdapter {
  let seq = 0;
  let lastPgCno: string | null = null;

  return {
    async approve(req: TerminalApproveRequest): Promise<TerminalApproveResult> {
      await delay(APPROVE_DELAY_MS);
      seq += 1;
      const pgCno = `mock-${Date.now()}-${seq}`;
      lastPgCno = pgCno;
      return {
        pgCno,
        approvalNo: String(10000000 + seq),
        cardNo: "123456******1234",
        issuerName: "MOCK카드",
        approvedAt: new Date().toISOString(),
        mid: MOCK_MID,
        tid: MOCK_TID,
        raw: { mock: true, request: req },
      };
    },

    async cancel(pgCno: string): Promise<TerminalCancelResult> {
      await delay(500);
      return { pgCno, cancelledAt: new Date().toISOString(), raw: { mock: true } };
    },

    async inquire(pgCno: string): Promise<TerminalTradeStatus> {
      await delay(300);
      return { pgCno, status: "APPROVED", raw: { mock: true } };
    },

    async reverseLast() {
      await delay(300);
      const ok = lastPgCno !== null;
      lastPgCno = null;
      return { ok };
    },

    async ping() {
      return { connected: true, firmware: "mock-1.0.0" };
    },
  };
}
