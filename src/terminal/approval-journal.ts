import Store from "electron-store";
import type { TerminalApproveResult } from "./types";

// 승인 저널 — 카드 승인의 생애를 디스크에 영속화한다.
// 승인 성공 ↔ 서버 반영 사이에 새로고침·크래시·재시작이 끼면 메모리(approvedRef/lastTx)가
// 유실되어 같은 구매에 재승인(이중 결제)이 가능했다. 저널이 있는 동안 새 승인을 차단하고,
// 복구 루프(recovery.ts)가 결과불명 건은 망취소(0440), 승인 건은 서버 반영으로 정리한다.
// 키오스크는 동시에 결제 1건이므로 슬롯은 하나만 둔다.

export type PendingApproval =
  | {
      state: "approving"; // 0200 송신 후 결과 불명 (크래시·통신 단절 시 이 상태로 남는다)
      orderId: string;
      orderNo: string;
      amount: number;
      serial: string; // 전문일련번호 — 승인번호 없는 망취소(0440)의 원거래 키
      startedAt: number;
    }
  | {
      state: "approved"; // VAN 승인 완료, 서버 반영 미확인
      orderId: string;
      orderNo: string;
      amount: number;
      serial: string;
      result: TerminalApproveResult;
      approvedAtMs: number;
    }
  | {
      state: "conflict"; // 서버가 반영을 확정 거부(금액 불일치·타 거래 결제됨 등) — 직원 확인 필요
      orderId: string;
      orderNo: string;
      amount: number;
      serial: string;
      result: TerminalApproveResult;
      reason: string;
    };

interface JournalSchema {
  pending?: PendingApproval;
  /** 전문일련번호 영속 카운터 — 같은 초·재시작 중복 방지 */
  serialSeq?: number;
}

/**
 * 전문일련번호 생성기 — yyMMdd(6) + 영속 카운터(6자리 순환).
 * 시간 기반(초 단위)은 같은 초의 두 거래·재시작 직후 재실행에서 중복될 수 있어,
 * 디스크 카운터로 단말 수명 전체에서 단조 증가를 보장한다 (KSnCAT 전문 스펙상 가맹점 임의 필드).
 */
export function createSerialGenerator(): () => string {
  const store = new Store<JournalSchema>({ name: "terminal-journal" });
  return () => {
    const seq = ((store.get("serialSeq") ?? 0) % 999_999) + 1;
    store.set("serialSeq", seq);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${String(now.getFullYear() % 100).padStart(2, "0")}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    return `${date}${String(seq).padStart(6, "0")}`;
  };
}

export interface ApprovalJournal {
  get(): PendingApproval | null;
  begin(entry: { orderId: string; orderNo: string; amount: number; serial: string }): void;
  markApproved(result: TerminalApproveResult): void;
  markConflict(reason: string): void;
  clear(): void;
  /** 이 프로세스에서 승인이 진행 중인지 (메모리 플래그) — 복구 루프가 진행 중 거래를 건드리지 않게 */
  isInFlight(): boolean;
  setInFlight(value: boolean): void;
}

export function createApprovalJournal(): ApprovalJournal {
  const store = new Store<JournalSchema>({ name: "terminal-journal" });
  let inFlight = false;

  return {
    get: () => store.get("pending") ?? null,
    begin(entry) {
      store.set("pending", { state: "approving", ...entry, startedAt: Date.now() });
    },
    markApproved(result) {
      const pending = store.get("pending");
      if (!pending) return;
      store.set("pending", {
        state: "approved",
        orderId: pending.orderId,
        orderNo: pending.orderNo,
        amount: pending.amount,
        serial: pending.serial,
        result,
        approvedAtMs: Date.now(),
      });
    },
    markConflict(reason) {
      const pending = store.get("pending");
      if (!pending || pending.state !== "approved") return;
      store.set("pending", { ...pending, state: "conflict", reason });
    },
    clear: () => store.delete("pending"),
    isInFlight: () => inFlight,
    setInFlight(value) {
      inFlight = value;
    },
  };
}
