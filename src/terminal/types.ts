// 카드단말(VAN 직결) 어댑터 타입
// 웹 앱이 사용하는 window.terminal 시그니처와 1:1 동기화되어야 한다.
// 시그니처 변경 시 웹/셸 양쪽을 함께 수정한다.

/** 승인 요청 */
export interface TerminalApproveRequest {
  amount: number;
  orderNo: string;
  /** 할부 개월 (0 = 일시불) */
  installment?: number;
  /** 면세 금액 */
  taxFreeAmount?: number;
}

/** 승인 결과 */
export interface TerminalApproveResult {
  /** VAN 거래번호 */
  pgCno: string;
  /** 승인번호 */
  approvalNo: string;
  /** 마스킹된 카드번호 ("123456******1234") */
  cardNo: string;
  /** 발급사명 */
  issuerName: string;
  /** ISO 8601 */
  approvedAt: string;
  /** 승인에 사용된 가맹점 번호 */
  mid: string;
  /** 승인에 사용된 단말기 번호 */
  tid: string;
  /** VAN 원본 응답 (감사 로그) */
  raw: unknown;
}

/** 취소 결과 */
export interface TerminalCancelResult {
  pgCno: string;
  cancelledAt: string;
  raw: unknown;
}

/** 거래 상태 조회 결과 */
export interface TerminalTradeStatus {
  pgCno: string;
  status: "APPROVED" | "CANCELLED" | "UNKNOWN";
  raw: unknown;
}

/** 카드단말 어댑터 — 구현체: mock (개발/시연), VAN 모듈 연동 (추후) */
export interface TerminalAdapter {
  approve(req: TerminalApproveRequest): Promise<TerminalApproveResult>;
  cancel(pgCno: string, reason: string): Promise<TerminalCancelResult>;
  inquire(pgCno: string): Promise<TerminalTradeStatus>;
  /** 망취소 — 승인 직후 통신 단절 시 직전 거래 취소 */
  reverseLast(): Promise<{ ok: boolean }>;
  /** 헬스체크 — 리더기 연결 상태 */
  ping(): Promise<{ connected: boolean; firmware?: string }>;
}
