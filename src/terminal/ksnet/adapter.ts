import net from "node:net";
import type { ApprovalJournal } from "../approval-journal";
import type { TerminalServerConfig } from "../server-config";
import type {
  TerminalAdapter,
  TerminalApproveRequest,
  TerminalApproveResult,
  TerminalCancelOriginal,
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
  /** 전자서명 유무 — "X": 무서명(기본), "K": KSnCAT 서명창, "T": 화면터치, " ": KSnCAT 설정 위임 */
  signMode?: "X" | "K" | "T" | " ";
  /** 부가세 필드 — "kscat": 0 전송(KSnCAT 자동부가세 위임, 기본), "explicit": 과세분 계산해 전송 */
  taxMode?: "kscat" | "explicit";
  /** 키오스크 연동 모드 결제창 부모 윈도우 핸들 (Windows HWND, 십진수 문자열) — 없으면 공백 전송 */
  getWindowHandle?: () => string | null;
  /** 승인 저널 — 승인 생애를 내구 기록해 크래시·재시작 시 복구를 가능하게 한다 */
  journal?: ApprovalJournal;
  /** 전문일련번호 생성기 — 미지정 시 시간 기반(makeSerial). 영속 카운터 주입으로 동시·재시작 중복 방지 */
  nextSerial?: () => string;
}

/** 데스크탑 전용 확장 — 복구 루프가 결과불명 거래를 망취소할 때 사용 */
export interface KsnetAdapterExtras {
  /** 승인번호 없는 망취소(0440) — 전문일련번호 기준. 결과불명 거래 정리용 */
  reverseBySerial(serial: string, amount: number): Promise<{ ok: boolean; indeterminate?: boolean }>;
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

/**
 * 수신 버퍼에서 응답 전문 한 프레임 추출.
 * 선두 4바이트 길이 필드(길이 제외 총 길이) 기준으로 정확히 자른다 — 선행 ACK 등
 * 잡음 바이트가 끼면 숫자가 아니게 되므로 ETX+CR 휴리스틱으로 폴백한다.
 */
function extractFrame(buf: Buffer): Buffer | null {
  if (buf.length >= 4) {
    const lenStr = buf.subarray(0, 4).toString("ascii");
    if (/^\d{4}$/.test(lenStr)) {
      const total = 4 + parseInt(lenStr, 10);
      return buf.length >= total ? buf.subarray(0, total) : null;
    }
  }
  if (buf.length >= 2 && buf[buf.length - 1] === 0x0d && buf[buf.length - 2] === 0x03) return buf;
  return null;
}

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
      const frame = extractFrame(Buffer.concat(chunks));
      if (frame) finish(null, frame);
    });
    socket.on("end", () => {
      // 불완전 프레임을 정상 응답으로 처리하지 않는다 — 결과 불명으로 남겨 망취소 경로를 태운다
      finish(new Error("카드단말 연결이 완전한 응답 없이 종료되었습니다"));
    });
    socket.on("error", (err) => finish(new Error(`카드단말 연결 실패: ${err.message}`)));
  });
}

/**
 * 부가세 명시 전송 시 계산 — 과세분(총액-면세)을 공급가액 1.1 배 포함으로 역산.
 * 공급가액 = round(과세분 / 1.1), 부가세 = 과세분 - 공급가액.
 * KSnCAT 자동부가세 계산식과 일치하는지, 전표 표기와 맞는지는 실기 확인.
 */
function computeTax(amount: number, taxFreeAmount: number): { tax: number; supplyAmount: number } {
  const taxable = Math.max(0, amount - taxFreeAmount);
  const supplyAmount = Math.round(taxable / 1.1);
  return { tax: taxable - supplyAmount, supplyAmount };
}

export function createKsnetAdapter(options: KsnetAdapterOptions): TerminalAdapter & KsnetAdapterExtras {
  const { host, port, getServerConfig, getWindowHandle, journal } = options;
  const approveTimeout = options.approveTimeoutMs ?? APPROVE_TIMEOUT_MS;
  const shortTimeout = options.shortTimeoutMs ?? SHORT_TIMEOUT_MS;
  const signMode = options.signMode ?? "X";
  const taxMode = options.taxMode ?? "kscat";
  const swModelNo = () => getWindowHandle?.() ?? "";
  const nextSerial = options.nextSerial ?? makeSerial;

  // 망취소(reverseLast)용 직전 거래 보관 — 프로세스 메모리 한정
  let lastTx: LastTransaction | null = null;

  // 전역 직렬화 — KSnCAT 은 단일 상주 데몬이라 승인·취소·망취소가 동시에 들어가면
  // 응답 혼선/거절 위험이 있다 (실기 동작 미확인). 모든 전문 교환을 한 줄로 세운다.
  let chain: Promise<unknown> = Promise.resolve();
  let busy = false;
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(
      async () => {
        busy = true;
        try {
          return await fn();
        } finally {
          busy = false;
        }
      },
      async () => {
        busy = true;
        try {
          return await fn();
        } finally {
          busy = false;
        }
      },
    );
    chain = run.catch(() => {});
    return run;
  }

  // 응답이 요청 거래의 것인지 대조 — 다른 거래·밀린 프레임의 응답을 성공으로 오인하지 않게
  const RESPONSE_TYPE: Record<string, string> = { "0200": "0210", "0420": "0430", "7420": "7450", "0440": "0450", "0460": "0470" };
  function validateResponse(
    requestType: string,
    serial: string,
    tid: string,
    response: { telegramType: string; serial: string; tid: string },
  ): void {
    const expected = RESPONSE_TYPE[requestType];
    if (expected && response.telegramType && response.telegramType !== expected) {
      throw new Error(`응답 전문 불일치 (${response.telegramType}, 기대 ${expected})`);
    }
    const respSerial = response.serial.replace(/\D/g, "");
    if (respSerial && respSerial !== serial) {
      throw new Error("응답 전문일련번호 불일치 — 다른 거래의 응답");
    }
    if (response.tid && response.tid !== tid) {
      throw new Error("응답 단말기번호(TID) 불일치");
    }
  }

  async function requireTid(): Promise<TerminalServerConfig> {
    let config: TerminalServerConfig | null;
    try {
      config = await getServerConfig();
    } catch {
      // 네트워크 장애를 "비활성화"로 뭉뚱그리면 현장에서 원인을 못 찾는다 — 구분해 안내
      throw new Error("서버 연결에 실패했습니다. 네트워크 상태를 확인해주세요.");
    }
    if (!config?.enabled) throw new Error("단말 직결 결제가 비활성화되어 있습니다");
    if (!config.tid) throw new Error("이 단말에 카드리더기 TID 가 설정되지 않았습니다");
    return config;
  }

  // 서명·부가세는 관리자 설정(서버)이 진실 소스 — 로컬 config 는 서버 미설정 시 폴백
  const resolveSignMode = (cfg: TerminalServerConfig): "X" | "K" | "T" | " " =>
    cfg.signMode ? (cfg.signMode === "pad" ? "K" : "X") : signMode;
  const resolveTaxMode = (cfg: TerminalServerConfig): "kscat" | "explicit" =>
    cfg.taxMode ? (cfg.taxMode === "explicit" ? "explicit" : "kscat") : taxMode;

  /** 승인번호 없는 망취소(0440) — 전문일련번호로 결과불명 거래를 취소한다.
   *  KSnCAT 이 확정 응답(O: 취소됨 / X·F: 원거래 없음 등)을 주면 정리된 것으로 보고,
   *  통신 실패만 indeterminate 로 남긴다. */
  async function reverseBySerialUnlocked(serial: string, amount: number): Promise<{ ok: boolean; indeterminate?: boolean }> {
    try {
      const { tid } = await requireTid();
      const telegram = buildApprovalTelegram({
        telegramType: "0440",
        tid,
        serial,
        amount,
        swModelNo: swModelNo(),
      });
      const response = parseApprovalResponse(await exchange(host, port, telegram, shortTimeout));
      validateResponse("0440", serial, tid, response);
      return { ok: response.status === "O" };
    } catch {
      return { ok: false, indeterminate: true };
    }
  }

  function reverseBySerial(serial: string, amount: number): Promise<{ ok: boolean; indeterminate?: boolean }> {
    return withLock(() => reverseBySerialUnlocked(serial, amount));
  }

  return {
    approve(req: TerminalApproveRequest): Promise<TerminalApproveResult> {
      return withLock(async () => {
      const config = await requireTid();
      const tid = config.tid;
      const serial = nextSerial();

      const taxFreeAmount = req.taxFreeAmount ?? 0;
      const taxFields = resolveTaxMode(config) === "explicit" ? computeTax(req.amount, taxFreeAmount) : {};
      const telegram = buildApprovalTelegram({
        telegramType: "0200",
        tid,
        serial,
        amount: req.amount,
        installment: req.installment ?? 0,
        taxFreeAmount,
        signMode: resolveSignMode(config),
        swModelNo: swModelNo(),
        ...taxFields,
      });

      // 전문 송신 전 저널 기록 — 크래시로 결과를 모르게 되면 serial 로 망취소(0440)한다
      journal?.begin({ orderId: req.orderId ?? "", orderNo: req.orderNo, amount: req.amount, serial });

      let response;
      try {
        response = parseApprovalResponse(await exchange(host, port, telegram, approveTimeout));
        validateResponse("0200", serial, tid, response);
      } catch (err) {
        // 결과 불명(타임아웃·소켓 오류) — 즉시 망취소를 시도해 승인됐을 가능성을 제거한다.
        // 망취소가 확정 응답을 받으면 저널을 지우고, 통신 자체가 안 되면 저널을 남겨
        // 복구 루프가 이어서 정리한다 (그동안 새 승인은 차단됨).
        const reversed = await reverseBySerialUnlocked(serial, req.amount);
        if (!reversed.indeterminate) journal?.clear();
        throw err;
      }

      if (response.status !== "O") {
        journal?.clear(); // 명확한 거절 — 승인된 거래가 없다
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

      const result: TerminalApproveResult = {
        pgCno: response.vanTr || serial,
        approvalNo: response.approvalNo,
        cardNo: response.maskedCardNo,
        issuerName: response.issuerName || response.acquirerName,
        approvedAt: new Date().toISOString(),
        mid: response.merchantNo,
        tid: response.tid || tid,
        raw: response.raw,
      };

      // 승인 결과를 서버 반영 전에 영속화 — 반영 확인(recovery.ts) 후 지워진다
      journal?.markApproved(result);

      return result;
      });
    },

    cancel(pgCno: string, _reason: string, original?: TerminalCancelOriginal): Promise<TerminalCancelResult> {
      return withLock(async () => {
      const { tid } = await requireTid();
      // 취소 전문(0420)의 원거래 키는 승인번호 + 승인일자(YYMMDD) — KSnCAT 연동 전문 순번 26·27.
      // 호출자가 서버 pgResponse 기반 원거래 정보를 넘기면 임의 과거 거래도 취소하고,
      // 없으면 직전 거래(프로세스 메모리)로 폴백한다.
      // 미확인(실기): 취소 시 KSnCAT 이 카드 재제시를 요구하는지 — 무카드 취소 허용 여부에 따라 취소 UX 가 갈린다.
      const orig =
        original ??
        (lastTx && (!pgCno || lastTx.vanTr === pgCno)
          ? { approvalNo: lastTx.approvalNo, approvalDate: lastTx.approvalDate, amount: lastTx.amount }
          : null);
      if (!orig) {
        throw new Error("취소할 원거래 정보를 찾을 수 없습니다 (원거래 승인번호·승인일자 전달 필요)");
      }

      // 부분취소(7420): cancelAmount 가 원거래 금액 미만일 때. 총금액 필드에 취소할 금액을 넣는다.
      const cancelAmount = original?.cancelAmount ?? orig.amount;
      if (cancelAmount > orig.amount) throw new Error("취소 금액이 원거래 승인금액을 초과합니다");
      const isPartial = cancelAmount < orig.amount;

      const cancelSerial = nextSerial();
      const telegram = buildApprovalTelegram({
        telegramType: isPartial ? "7420" : "0420",
        tid,
        serial: cancelSerial,
        amount: cancelAmount,
        originalApprovalNo: orig.approvalNo,
        originalApprovalDate: orig.approvalDate,
        swModelNo: swModelNo(),
      });

      const response = parseApprovalResponse(await exchange(host, port, telegram, approveTimeout));
      validateResponse(isPartial ? "7420" : "0420", cancelSerial, tid, response);
      if (response.status !== "O") {
        const reason = [response.message1, response.message2].filter(Boolean).join(" ");
        throw new Error(reason || `취소 거절 (${response.responseCode})`);
      }

      // 부분취소는 원거래가 잔액으로 살아 있으므로 직전 거래 보관을 유지한다
      if (!isPartial && lastTx && lastTx.approvalNo === orig.approvalNo) lastTx = null;
      return { pgCno: response.vanTr || pgCno, cancelledAt: new Date().toISOString(), raw: response.raw };
      });
    },

    async inquire(pgCno: string): Promise<TerminalTradeStatus> {
      // KSnCAT 로컬 프로토콜에는 임의 거래 조회가 없다 — 직전 거래만 판별 가능
      if (lastTx?.vanTr === pgCno) {
        return { pgCno, status: "APPROVED", raw: { source: "last-transaction" } };
      }
      return { pgCno, status: "UNKNOWN", raw: { source: "not-tracked" } };
    },

    reverseLast(): Promise<{ ok: boolean }> {
      return withLock(async () => {
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
        swModelNo: swModelNo(),
      });

      const response = parseApprovalResponse(await exchange(host, port, telegram, approveTimeout));
      validateResponse("0460", lastTx.serial, tid, response);
      const ok = response.status === "O";
      if (ok) lastTx = null;
      return { ok };
      });
    },

    reverseBySerial,

    async ping(): Promise<{ connected: boolean; firmware?: string }> {
      // 승인·취소 진행 중이면 리더기를 건드리지 않는다 — 데몬이 살아 거래 중이므로 정상으로 본다
      if (busy) return { connected: true, firmware: "busy" };
      return withLock(async () => {
        try {
          const response = parseReaderStatusResponse(
            await exchange(host, port, buildReaderStatusTelegram(), shortTimeout),
          );
          return { connected: response.errorCode === "0000", firmware: `card:${response.cardStatus || "-"}` };
        } catch {
          return { connected: false };
        }
      });
    },
  };
}
