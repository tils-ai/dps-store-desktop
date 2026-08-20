import { net } from "electron";
import type { TerminalAdapter, TerminalCancelOriginal } from "./types";

// 원격 취소 폴러 — 관리자가 다른 PC 에서 요청한 카드 취소를 이 단말이 대신 실행한다.
// 서버가 remoteCancelEnabled(관리자 설정)일 때만 요청을 내려주므로 여기서는 설정 분기가 없다.
// 취소 실행 중 승인 요청과 겹치지 않게 순차 처리하며, 성공/실패 모두 결과를 보고한다.

const POLL_INTERVAL_MS = 30_000;

type PendingCancelRequest = {
  id: string;
  orderId: string;
  reason: string;
  pgCno: string;
  approvalNo: string;
  approvedAt: string; // ISO
  amount: number;
  cancelAmount: number | null;
};

export interface CancelPollerDeps {
  adapter: TerminalAdapter;
  getTarget: () => { baseUrl: string; tenantName: string } | null;
}

/** ISO 시각 → VAN 승인일자 YYMMDD (한국시간 기준) */
function toApprovalDate(iso: string): string {
  const kst = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(2, 10).replace(/-/g, "");
}

export function startCancelPoller(deps: CancelPollerDeps): NodeJS.Timeout {
  let running = false;

  const tick = async () => {
    if (running) return; // 이전 주기 처리 중이면 건너뜀 (취소는 리더기 대기가 길 수 있다)
    const target = deps.getTarget();
    if (!target) return;
    running = true;

    try {
      const listRes = await net.fetch(
        `${target.baseUrl}/api/terminal/cancel-requests?tenant=${encodeURIComponent(target.tenantName)}`,
        { credentials: "include", signal: AbortSignal.timeout(15_000) },
      );
      if (!listRes.ok) return;
      const { requests } = (await listRes.json()) as { requests: PendingCancelRequest[] };

      for (const req of requests ?? []) {
        let ok = false;
        let cancelResult: unknown = null;
        let message = "";
        try {
          const original: TerminalCancelOriginal = {
            approvalNo: req.approvalNo,
            approvalDate: toApprovalDate(req.approvedAt),
            amount: req.amount,
            ...(req.cancelAmount ? { cancelAmount: req.cancelAmount } : {}),
          };
          cancelResult = await deps.adapter.cancel(req.pgCno, req.reason, original);
          ok = true;
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }

        await net.fetch(`${target.baseUrl}/api/terminal/cancel-requests/${req.id}/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ tenant: target.tenantName, ok, cancelResult, message }),
        });
      }
    } catch {
      // 서버 미도달 — 다음 주기 재시도
    } finally {
      running = false;
    }
  };

  return setInterval(tick, POLL_INTERVAL_MS);
}
