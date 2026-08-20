import { net } from "electron";
import type { ApprovalJournal } from "./approval-journal";
import type { KsnetAdapterExtras } from "./ksnet/adapter";
import type { TerminalAdapter } from "./types";

// 승인 복구 루프 — 저널에 남은 미정리 승인을 부팅 시·주기적으로 정리한다.
// - approving(결과 불명): 승인번호 없는 망취소(0440)로 승인 가능성을 제거
// - approved(서버 반영 미확인): 셸이 직접 /api/kiosk/payment 반영을 재시도 (renderer 생사와 무관)
// - conflict(서버가 확정 거부): 자동 처리 중단 — 진단 다이얼로그에서 직원이 확인 후 삭제
// 저널이 남아 있는 동안 새 승인은 차단되므로(main.ts guard), 이 루프가 이중 결제 창을 닫는다.

const RECOVERY_INTERVAL_MS = 20_000;
const BOOT_DELAY_MS = 15_000; // 부팅 직후 KSnCAT·네트워크 안정화 대기

export interface RecoveryDeps {
  adapter: TerminalAdapter & Partial<KsnetAdapterExtras>;
  journal: ApprovalJournal;
  getTarget: () => { baseUrl: string; tenantName: string } | null;
}

async function reportApprovalToServer(deps: RecoveryDeps): Promise<void> {
  const pending = deps.journal.get();
  if (!pending || pending.state !== "approved") return;
  const target = deps.getTarget();
  if (!target) return;
  if (!pending.orderId) return; // 구버전 renderer 승인 건 — renderer 재전송(replay) 경로로만 반영 가능

  const res = await net.fetch(`${target.baseUrl}/api/kiosk/payment/${pending.orderId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      tenant: target.tenantName,
      platform: "windows",
      amount: pending.amount,
      terminalResult: pending.result,
    }),
  });

  if (res.ok) {
    deps.journal.clear();
    return;
  }
  if (res.status >= 500) return; // 서버 오류 — 다음 주기 재시도

  // 4xx 확정 거부 — 승인은 존재하는데 반영이 불가능한 상태 (타 거래 결제됨·취소됨·금액 불일치).
  // 자동 반영을 멈추고 직원 확인 상태로 전환 + 모니터링 이벤트로 관리자에게 노출한다.
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  const reason = data?.error || `반영 거부 (HTTP ${res.status})`;
  deps.journal.markConflict(reason);
  net
    .fetch(`${target.baseUrl}/api/terminal/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        tenant: target.tenantName,
        type: "APPROVE_FAIL",
        orderId: pending.orderId,
        message: `미반영 승인 충돌(승인번호 ${pending.result.approvalNo}): ${reason}`,
      }),
    })
    .catch(() => {});
}

export function startApprovalRecovery(deps: RecoveryDeps): NodeJS.Timeout {
  let running = false;

  const tick = async () => {
    if (running || deps.journal.isInFlight()) return;
    const pending = deps.journal.get();
    if (!pending) return;
    running = true;
    try {
      if (pending.state === "approving") {
        // 결과 불명 — 망취소(0440)로 정리. 확정 응답(취소됨/원거래 없음)이면 저널 삭제,
        // KSnCAT 미도달이면 다음 주기 재시도. reverseBySerial 이 없는 어댑터(mock)는 즉시 삭제.
        if (!deps.adapter.reverseBySerial) {
          deps.journal.clear();
        } else {
          const reversed = await deps.adapter.reverseBySerial(pending.serial, pending.amount);
          if (!reversed.indeterminate) deps.journal.clear();
        }
      } else if (pending.state === "approved") {
        await reportApprovalToServer(deps);
      }
      // conflict: 자동 처리 없음 — 진단 다이얼로그에서 수동 삭제
    } catch {
      // 다음 주기 재시도
    } finally {
      running = false;
    }
  };

  setTimeout(tick, BOOT_DELAY_MS);
  return setInterval(tick, RECOVERY_INTERVAL_MS);
}
