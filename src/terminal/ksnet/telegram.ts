import iconv from "iconv-lite";

// KSnCAT(KSNET 승인 데몬) 로컬 소켓 전문 조립/파싱
// - 신규 통합전문(카드번호 암호화) 기준: 승인 0200 / 취소 0420 / 단말 망취소 0460
// - 고정폭 바이트 필드 + EUC-KR 응답 텍스트. 카드 리딩·EMV·서명은 KSnCAT 이 전담하고
//   여기서는 금액/단말기번호만 채운 전문을 보내면 된다 (키오스크 연동 모드).

const STX = 0x02;
const ETX = 0x03;
const CR = 0x0d;
const FS = 0x1c;

const ENCODING = "euc-kr";

/** 고정폭 필드 — 값이 넘치면 잘라내고, 모자라면 fill 문자로 우측 패딩 */
function fixed(value: string, length: number, fill = " "): Buffer {
  const raw = iconv.encode(value, ENCODING);
  if (raw.length >= length) return raw.subarray(0, length);
  return Buffer.concat([raw, Buffer.alloc(length - raw.length, fill)]);
}

/** 숫자 필드 — Right Justified + Leading Zero */
function numeric(value: number | string, length: number): Buffer {
  const s = String(value).replace(/\D/g, "").slice(-length);
  return Buffer.from(s.padStart(length, "0"), "ascii");
}

// 0440: 승인번호 없는 망취소 — 결과불명 거래(크래시·통신 단절)를 전문일련번호로 취소한다
export type ApprovalTelegramType = "0200" | "0420" | "7420" | "0440" | "0460";

export interface ApprovalRequestFields {
  telegramType: ApprovalTelegramType;
  /** 카드리더기 TID (10자리) */
  tid: string;
  /** 전문일련번호 12자리 — 망취소(0460) 시 원거래의 일련번호를 그대로 넣는다 */
  serial: string;
  /** 총금액 (원) */
  amount: number;
  /** 할부 개월 (0 = 일시불) */
  installment?: number;
  /** 면세금액 (원) */
  taxFreeAmount?: number;
  /** 취소/망취소 시 원거래 승인번호 */
  originalApprovalNo?: string;
  /** 취소/망취소 시 원거래 승인일자 (YYMMDD) */
  originalApprovalDate?: string;
  /** 세금(부가세) — 0 이면 KSnCAT 자동부가세 설정에 위임 */
  tax?: number;
  /** 공급금액 — 0 이면 KSnCAT 자동부가세 설정에 위임 */
  supplyAmount?: number;
  /** SW 모델번호 — 키오스크 연동 모드에서 결제창 부모 윈도우 핸들 (십진수 문자열, 형식은 실기 확인) */
  swModelNo?: string;
  /**
   * 전자서명 유무 — 공백: KSnCAT 설정에 따름, "X": 무서명, "K": KSnCAT 서명창 사용
   * 무인 키오스크는 보통 "X"(무서명) 또는 KSnCAT 설정 위임을 쓴다.
   */
  signMode?: " " | "X" | "K" | "T";
  /**
   * 키오스크 연동 모드(암호화 여부 "K") 사용 여부.
   *
   * 이 모드는 KSnCAT 이 자체 안내창을 띄우지 않고 **SW 모델번호에 넣은 윈도우 핸들로
   * Windows 메시지를 보내** 호출자가 화면을 그리게 하는 방식이다. Electron 은 그 메시지를
   * 받지 않으므로 켜 두면 KSnCAT 이 전문 오류(1001)로 거절한다 (2026-09-15 현장 확인).
   *
   * 기본값은 끔 — 공백을 보내면 KSnCAT 이 자체 안내창으로 카드를 받는다.
   */
  kioskMode?: boolean;
  /**
   * 거래구분 — 기본 "IC"(신용 IC).
   *
   * 규격상 "MI"(MS/IC 겸용)도 유효하지만 이 KSnCAT 조합에서는 전문 오류(1001)로 거절됐다.
   * 같은 단말의 단독결제가 "IC" 로 정상 승인된 것을 확인해 기본값을 맞췄다.
   * MS(마그네틱) 카드까지 받아야 하면 config 로 "MI" 를 지정한다.
   */
  txType?: "MI" | "IC" | "MS";
  /**
   * 암호화 여부 필드 값 — 기본 "A"(ACK & EOT 전송 안함).
   *
   * 공백은 ACK & EOT 핸드셰이크를 전제하는데 우리 소켓 교환은 그것을 쓰지 않는다.
   * 다만 전문 오류(1001)의 실제 원인은 거래구분("MI")이었고, 이 값을 "A" 로 바꾼 것과
   * 거래구분을 "IC" 로 바꾼 것이 연달아 있어 **"A" 가 꼭 필요한지는 확인되지 않았다.**
   * 공백으로 되돌려 시험할 수 있게 열어 둔다.
   */
  encryptFlag?: "" | "A";
}

/** 승인/취소/망취소 요청 전문 조립 */
export function buildApprovalTelegram(f: ApprovalRequestFields): Buffer {
  const body = Buffer.concat([
    Buffer.from([STX]),
    fixed(f.txType ?? "IC", 2), // 거래구분: 기본 신용 IC
    fixed("01", 2), // 업무구분: 승인/취소
    fixed(f.telegramType, 4), // 전문구분
    fixed("N", 1), // 거래형태: 일반
    fixed(f.tid, 10), // 단말기번호
    fixed("", 4), // 업체정보
    numeric(f.serial, 12), // 전문일련번호 (망취소 원거래 키)
    fixed("", 1), // Pos Entry Mode
    fixed("", 20), // 거래고유번호
    fixed("", 20), // 카드번호 (KSnCAT 리더기 입력)
    /*
       암호화 여부 — **기본(공백)은 ACK & EOT 핸드셰이크를 전제한다.** 우리 소켓 교환은
       전문만 주고받고 ACK(0x06)를 쓰지 않으므로 "A"(ACK & EOT 전송 안함)를 보낸다.
       공백으로 두면 KSnCAT 이 전문 오류(1001)로 거절한다 (2026-09-15 현장 확인).
       "K"(키오스크 연동 모드)는 윈도우 핸들로 메시지를 받는 방식이라 Electron 에서 못 쓴다.
    */
    fixed(f.kioskMode ? "K" : (f.encryptFlag ?? "A"), 1), // 암호화 여부
    // 윈도우 핸들은 키오스크 연동 모드에서만 의미가 있다. 끈 상태로 보내면 KSnCAT 이
    // 쓰지 않는 값이 들어가 전문 검증에 걸린다
    fixed(f.kioskMode ? (f.swModelNo ?? "") : "", 16), // SW 모델번호
    fixed("", 16), // CAT or Reader 모델번호
    fixed("", 40), // 암호화 정보
    fixed("", 37), // Track II
    Buffer.from([FS]),
    numeric(f.installment ?? 0, 2), // 할부개월
    numeric(f.amount, 12), // 총금액
    numeric(0, 12), // 봉사료
    numeric(f.tax ?? 0, 12), // 세금(부가세) — 0 이면 KSnCAT 자동부가세 설정 사용
    numeric(f.supplyAmount ?? 0, 12), // 공급금액 — 0 이면 KSnCAT 자동부가세 설정 사용
    numeric(f.taxFreeAmount ?? 0, 12), // 면세금액
    fixed("", 2), // Working Key Index
    fixed("", 16), // 비밀번호
    fixed(f.originalApprovalNo ?? "", 12), // 원거래승인번호
    fixed(f.originalApprovalDate ?? "", 6), // 원거래승인일자
    fixed("", 13), // 사용자정보
    fixed("", 2), // 가맹점ID (KSNET 부여 — 임의 사용 금지)
    fixed("", 30), // 가맹점사용필드
    fixed("", 4), // Reserved
    fixed("", 20), // KSNET Reserved
    fixed("N", 1), // 동글구분: 일반 신용 거래
    fixed("", 1), // 매체구분
    fixed("", 1), // 이통사구분
    fixed("", 1), // 신용카드종류
    fixed("", 30), // filler
    fixed("", 60), // DCC 환율조회 Data
    // 거래형태에 의한 Data (V) — 일반 신용 거래는 없음
    fixed(f.signMode ?? "X", 1), // 전자서명 유무 (기본 무서명 — 키오스크)
    Buffer.from([ETX]),
    Buffer.from([CR]),
  ]);

  // 길이(4): 길이필드 제외 전문 총 길이
  return Buffer.concat([numeric(body.length, 4), body]);
}

export interface ApprovalResponseFields {
  telegramType: string; // 0210/0430/0470 등
  tid: string;
  serial: string;
  /** 'O': 정상, 'X': 거절, 'F': KSCAT 거절 */
  status: string;
  /** KSNET 표준응답코드 */
  responseCode: string;
  /** 카드사 응답코드 */
  issuerResponseCode: string;
  /** 거래일시 YYMMDDhhmmss */
  transactedAt: string;
  message1: string;
  message2: string;
  approvalNo: string;
  /** 거래고유번호 (VANTR 12자리) */
  vanTr: string;
  /** 가맹점 번호 */
  merchantNo: string;
  issuerCode: string;
  issuerName: string;
  acquirerCode: string;
  acquirerName: string;
  /** 마스킹 카드번호 (filler 필드 — BIN 6자리 표시) */
  maskedCardNo: string;
  raw: string;
}

/** 결제 응답 전문 파싱 (고정폭) */
export function parseApprovalResponse(buf: Buffer): ApprovalResponseFields {
  // 길이(4) 이후부터 필드 시작
  let o = 4;
  const take = (n: number): string => {
    const s = iconv.decode(buf.subarray(o, o + n), ENCODING);
    o += n;
    return s.trim();
  };

  o += 1; // STX
  take(2); // 거래구분
  take(2); // 업무구분
  const telegramType = take(4);
  take(1); // 거래형태
  const tid = take(10);
  take(4); // 업체정보
  const serial = take(12);
  const status = take(1);
  const responseCode = take(4);
  const issuerResponseCode = take(4);
  const transactedAt = take(12);
  take(1); // 카드 Type
  const message1 = take(16);
  const message2 = take(16);
  const approvalNo = take(12);
  const vanTr = take(20);
  const merchantNo = take(15);
  const issuerCode = take(2);
  const issuerName = take(16);
  const acquirerCode = take(2);
  const acquirerName = take(16);
  take(2); // Working Key Index
  take(16); // Working Key
  take(9); // 잔액
  take(9); // 포인트1
  take(9); // 포인트2
  take(9); // 포인트3
  take(20); // Notice1
  take(40); // Notice2
  take(5); // Reserved
  take(40); // KSNET Reserved
  const maskedCardNo = take(30); // filler — 마스킹 카드번호

  return {
    telegramType,
    tid,
    serial,
    status,
    responseCode,
    issuerResponseCode,
    transactedAt,
    message1,
    message2,
    approvalNo,
    vanTr,
    merchantNo,
    issuerCode,
    issuerName,
    acquirerCode,
    acquirerName,
    maskedCardNo,
    raw: iconv.decode(buf, ENCODING),
  };
}

/** 보조기능 요청 — S4: 리더기 카드 삽입 상태 확인 (헬스체크용) */
export function buildReaderStatusTelegram(): Buffer {
  // 보조기능 프레임은 승인 전문과 달리 STX 가 먼저 온다: STX + 길이(4) + Command(2) + Filler(3) + ETX + CR
  const body = Buffer.concat([fixed("S4", 2), fixed("", 3), Buffer.from([ETX]), Buffer.from([CR])]);
  return Buffer.concat([Buffer.from([STX]), numeric(body.length, 4), body]);
}

export interface ReaderStatusResponse {
  /** "0000" = 정상 */
  errorCode: string;
  /** INS: 삽입, DEL: 제거, GAT: 입구에 카드 존재 */
  cardStatus: string;
}

/** 보조기능 S4 응답 파싱 */
export function parseReaderStatusResponse(buf: Buffer): ReaderStatusResponse {
  // STX(1) + 길이(4) + Command(2) + ErrorCode(4) + 상태(3) + ETX + CR
  const text = iconv.decode(buf, ENCODING);
  return {
    errorCode: text.slice(7, 11).trim(),
    cardStatus: text.slice(11, 14).trim(),
  };
}

/** 전문일련번호 생성 — 12자리 (yyMMddHHmmss). 망취소 시 원거래 키로 재사용된다 */
export function makeSerial(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    String(now.getFullYear()).slice(-2) +
    p(now.getMonth() + 1) +
    p(now.getDate()) +
    p(now.getHours()) +
    p(now.getMinutes()) +
    p(now.getSeconds())
  );
}
