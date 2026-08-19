import net from "node:net";
import type { TerminalServerConfig } from "../server-config";
import type {
  TerminalAdapter,
  TerminalApproveRequest,
  TerminalApproveResult,
  TerminalCancelResult,
  TerminalTradeStatus,
} from "../types";
import {
  buildApprovalTelegram,
  buildReaderStatusTelegram,
  makeSerial,
  parseApprovalResponse,
  parseReaderStatusResponse,
} from "./telegram";

// KSNET 카드단말 어댑터 — 로컬 KSnCAT(승인 데몬)에 TCP 로 전문을 주고받는다.
// KSnCAT 이 리더기 제어·EMV·VAN 승인 통신을 전담하므로 여기서는 전문 송수신만 한다.
// 접속 포트는 KSnCAT 앱 설정의 "인터페이스 포트" 값과 일치해야 한다.

export interface KsnetAdapterOptions {
  host: string;
  port: number;
  /** 카드 삽입 대기 포함 승인 응답 타임아웃 (ms) */
  approveTimeoutMs?: number;
  /** 헬스체크 등 짧은 요청 타임아웃 (ms) */
  shortTimeoutMs?: number;
  /** 서버(웹 관리자) 설정 조회 — 승인 시점마다 TID 를 받아온다 */
  getServerConfig: () => Promise<TerminalServerConfig | null>;
}

const APPROVE_TIMEOUT_MS = 90_000; // 카드 삽입 대기 포함
const SHORT_TIMEOUT_MS = 10_000;

type LastTransaction = {
  serial: string;
  approvalNo: string;
  approvalDate: string; // YYMMDD
  amount: number;
  vanTr: string;
};

/** KSnCAT 에 전문 1건 송신 → 응답 수신 (연결은 요청 단위) */
function exchange(host: string, port: number, payload: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (err: Error | null, data?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(data as Buffer);
    };

    const timer = setTimeout(() => finish(new Error("카드단말 응답 시간 초과")), timeoutMs);

    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      // 응답 전문 끝은 ETX(0x03) + CR(0x0D)
      if (buf.length >= 2 && buf[buf.length - 1] === 0x0d && buf[buf.length - 2] === 0x03) {
        finish(null, buf);
      }
    });
    socket.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (buf.length > 0) finish(null, buf);
      else finish(new Error("카드단말 연결이 응답 없이 종료되었습니다"));
    });
    socket.on("error", (err) => finish(new Error(`카드단말 연결 실패: ${err.message}`)));
  });
}

export function createKsnetAdapter(options: KsnetAdapterOptions): TerminalAdapter {
  const { host, port, getServerConfig } = options;
  const approveTimeout = options.approveTimeoutMs ?? APPROVE_TIMEOUT_MS;
  const shortTimeout = options.shortTimeoutMs ?? SHORT_TIMEOUT_MS;

  // 망취소(reverseLast)용 직전 거래 보관 — 프로세스 메모리 한정
  let lastTx: LastTransaction | null = null;

  async function requireTid(): Promise<{ tid: string; mid: string }> {
    const config = await getServerConfig();
    if (!config?.enabled) throw new Error("단말 직결 결제가 비활성화되어 있습니다");
    if (!config.tid) throw new Error("이 단말에 카드리더기 TID 가 설정되지 않았습니다");
    return { tid: config.tid, mid: config.mid };
  }

  return {
    async approve(req: TerminalApproveRequest): Promise<TerminalApproveResult> {
      const { tid } = await requireTid();
      const serial = makeSerial();

      const telegram = buildApprovalTelegram({
        telegramType: "0200",
        tid,
        serial,
        amount: req.amount,
        installment: req.installment ?? 0,
        taxFreeAmount: req.taxFreeAmount ?? 0,
      });

      const response = parseApprovalResponse(await exchange(host, port, telegram, approveTimeout));

      if (response.status !== "O") {
        const reason = [response.message1, response.message2].filter(Boolean).join(" ");
        throw new Error(reason || `카드 승인 거절 (${response.responseCode})`);
      }

      lastTx = {
        serial,
        approvalNo: response.approvalNo,
        approvalDate: response.transactedAt.slice(0, 6),
        amount: req.amount,
        vanTr: response.vanTr,
      };

      return {
        pgCno: response.vanTr || serial,
        approvalNo: response.approvalNo,
        cardNo: response.maskedCardNo,
        issuerName: response.issuerName || response.acquirerName,
        approvedAt: new Date().toISOString(),
        mid: response.merchantNo,
        tid: response.tid || tid,
        raw: response.raw,
      };
    },

    async cancel(pgCno: string, _reason: string): Promise<TerminalCancelResult> {
      const { tid } = await requireTid();
      // 오프라인 카드 취소는 원거래 승인번호/일자가 필요하다. 현재는 직전 거래만 지원 —
      // 임의 거래 취소 UX 는 실기 검증 단계에서 원거래 정보 전달 방식과 함께 확정한다.
      if (!lastTx || (pgCno && lastTx.vanTr !== pgCno)) {
        throw new Error("취소할 원거래 정보를 찾을 수 없습니다 (직전 거래만 취소 가능)");
      }

      const telegram = buildApprovalTelegram({
        telegramType: "0420",
        tid,
        serial: makeSerial(),
        amount: lastTx.amount,
        originalApprovalNo: lastTx.approvalNo,
        originalApprovalDate: lastTx.approvalDate,
      });

      const response = parseApprovalResponse(await exchange(host, port, telegram, approveTimeout));
      if (response.status !== "O") {
        const reason = [response.message1, response.message2].filter(Boolean).join(" ");
        throw new Error(reason || `취소 거절 (${response.responseCode})`);
      }

      lastTx = null;
      return { pgCno: response.vanTr || pgCno, cancelledAt: new Date().toISOString(), raw: response.raw };
    },

    async inquire(pgCno: string): Promise<TerminalTradeStatus> {
      // KSnCAT 로컬 프로토콜에는 임의 거래 조회가 없다 — 직전 거래만 판별 가능
      if (lastTx?.vanTr === pgCno) {
        return { pgCno, status: "APPROVED", raw: { source: "last-transaction" } };
      }
      return { pgCno, status: "UNKNOWN", raw: { source: "not-tracked" } };
    },

    async reverseLast(): Promise<{ ok: boolean }> {
      if (!lastTx) return { ok: false };
      const { tid } = await requireTid();

      // 단말 망취소(0460) — 원거래 전문일련번호를 그대로 사용
      const telegram = buildApprovalTelegram({
        telegramType: "0460",
        tid,
        serial: lastTx.serial,
        amount: lastTx.amount,
        originalApprovalNo: lastTx.approvalNo,
        originalApprovalDate: lastTx.approvalDate,
      });

      const response = parseApprovalResponse(await exchange(host, port, telegram, approveTimeout));
      const ok = response.status === "O";
      if (ok) lastTx = null;
      return { ok };
    },

    async ping(): Promise<{ connected: boolean; firmware?: string }> {
      try {
        const response = parseReaderStatusResponse(
          await exchange(host, port, buildReaderStatusTelegram(), shortTimeout),
        );
        return { connected: response.errorCode === "0000", firmware: `card:${response.cardStatus || "-"}` };
      } catch {
        return { connected: false };
      }
    },
  };
}
