/**
 * ESC/POS 명령 빌더 + 키오스크 접수증 포맷
 *
 * 대상 프린터: Sewoo SCP-380CII (80mm 감열, COM2 / 9600 / 8N1)
 * - 한글: KS5601 (EUC-KR) + 한글 모드(`FS &`)
 * - QR: GS ( k 표준 명령 (model 2)
 * - 한 줄 폭: 48자 (영문 기준) — 한글은 2바이트라 24자
 *
 * 영수증 양식: equip-sync-l-module의 정보 구조를 ESC/POS로 표현
 *  · 브랜드명 → 주문번호/일시 → 수령인/연락처
 *  · 상품×옵션×수량×금액
 *  · 상품/배송/할인 → 총 결제금액
 *  · 결제수단 → 안내문 + QR → 출력 시각 → cut
 */

import iconv from "iconv-lite";

const ESC = 0x1b;
const GS = 0x1d;
const FS = 0x1c;
const LF = 0x0a;

/** 80mm 감열 영문 기준 1줄 폭 (한글은 2바이트라 24자로 환산) */
const LINE_WIDTH = 48;

export const cmd = {
  init: () => Buffer.from([ESC, 0x40]),
  /** 한글 모드 ON — 이후 텍스트는 KS5601 이중 바이트로 해석 */
  koreanOn: () => Buffer.from([FS, 0x26]),
  align: (n: 0 | 1 | 2) => Buffer.from([ESC, 0x61, n]), // 0=left, 1=center, 2=right
  bold: (on: boolean) => Buffer.from([ESC, 0x45, on ? 1 : 0]),
  /** width/height 배수 (0=기본, 1=2배). GS ! n */
  size: (w: 0 | 1, h: 0 | 1) => Buffer.from([GS, 0x21, (w << 4) | h]),
  underline: (on: boolean) => Buffer.from([ESC, 0x2d, on ? 1 : 0]),
  feed: (n = 1) => Buffer.from(new Array(n).fill(LF)),
  /** GS V m — 1B = full cut, 0x01 = partial. 일부 모델은 0x42(feed+cut) 필요 */
  cut: () => Buffer.from([GS, 0x56, 0x01]),
};

/** 한글 텍스트를 EUC-KR로 인코딩 (한글 모드 ON 상태 가정) */
export function text(s: string): Buffer {
  return iconv.encode(s, "euc-kr");
}

/** 문자열 + 줄바꿈 */
export function line(s = ""): Buffer {
  return Buffer.concat([text(s), Buffer.from([LF])]);
}

/** 좌-우 분할 라인. 한글 1자 = 2칸으로 계산 */
export function leftRight(left: string, right: string, width = LINE_WIDTH): Buffer {
  const lw = visualWidth(left);
  const rw = visualWidth(right);
  const gap = Math.max(1, width - lw - rw);
  return line(left + " ".repeat(gap) + right);
}

/** 한글=2, 영문/숫자/기호=1로 환산한 디스플레이 폭 */
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  }
  return w;
}

/** 점선 구분선 */
export function divider(char = "-", width = LINE_WIDTH): Buffer {
  return line(char.repeat(width));
}

/**
 * QR 코드 출력 (ESC/POS 표준 GS ( k, model 2)
 * - moduleSize: 1-16 (보통 6-8)
 * - errorCorrection: "L" | "M" | "Q" | "H"
 */
export function qrCode(
  data: string,
  opts: { moduleSize?: number; errorCorrection?: "L" | "M" | "Q" | "H" } = {}
): Buffer {
  const moduleSize = Math.min(16, Math.max(1, opts.moduleSize ?? 6));
  const ecMap = { L: 48, M: 49, Q: 50, H: 51 } as const;
  const ec = ecMap[opts.errorCorrection ?? "M"];

  // 1) 모델 지정 (모델 2)
  const setModel = Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]);
  // 2) 모듈 크기
  const setSize = Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize]);
  // 3) 에러 정정 레벨
  const setEc = Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, ec]);
  // 4) 데이터 저장 (pL pH = data length + 3)
  const dataBuf = Buffer.from(data, "ascii");
  const len = dataBuf.length + 3;
  const pL = len & 0xff;
  const pH = (len >> 8) & 0xff;
  const storeData = Buffer.concat([
    Buffer.from([GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]),
    dataBuf,
  ]);
  // 5) 출력
  const print = Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);

  return Buffer.concat([setModel, setSize, setEc, storeData, print]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 영수증 데이터 → ESC/POS 바이트
// ─────────────────────────────────────────────────────────────────────────────

export interface ReceiptItem {
  name: string;
  option?: string;
  quantity: number;
  price: number;
}

export interface ReceiptData {
  brandName: string;
  orderNumber: string;
  /** ISO 문자열 또는 표시용 문자열. ISO면 표시 포맷으로 변환 */
  createdAt: string;
  recipientName?: string;
  recipientPhone?: string;
  items: ReceiptItem[];
  subtotal: number;
  deliveryCost?: number;
  discount?: number;
  totalAmount: number;
  paymentMethod?: string;
  /** my 페이지 deep link — 인증 hash 포함 권장 */
  qrUrl?: string;
  /** 안내 문구 (기본: "QR을 찍어 주문 상세를 확인하세요") */
  qrCaption?: string;
  /** 매장용/고객용 등 사본 라벨 */
  copyLabel?: string;
  /** 접수증 포맷 — "counter"이면 담당자 수기 기입란 노출 */
  receiptFormat?: "counter" | "privacy";
}

function formatPrice(n: number): string {
  return `${n.toLocaleString("ko-KR")}원`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildReceipt(d: ReceiptData): Buffer {
  const parts: Buffer[] = [];

  // 헤더
  parts.push(cmd.init());
  parts.push(cmd.koreanOn());
  parts.push(cmd.align(1));
  parts.push(cmd.size(1, 1));
  parts.push(cmd.bold(true));
  parts.push(line(d.brandName));
  parts.push(cmd.bold(false));
  parts.push(cmd.size(0, 0));
  if (d.copyLabel) {
    parts.push(line(`[${d.copyLabel}]`));
  }
  parts.push(cmd.feed(1));

  // 주문번호 / 일시
  parts.push(cmd.align(0));
  parts.push(divider());
  parts.push(cmd.size(1, 0));
  parts.push(cmd.bold(true));
  parts.push(line(`주문 ${d.orderNumber}`));
  parts.push(cmd.bold(false));
  parts.push(cmd.size(0, 0));
  parts.push(line(formatDateTime(d.createdAt)));

  if (d.recipientName || d.recipientPhone) {
    parts.push(cmd.feed(1));
    if (d.recipientName) parts.push(line(`수령: ${d.recipientName}`));
    if (d.recipientPhone) parts.push(line(`연락: ${d.recipientPhone}`));
  }

  // 상품 목록
  parts.push(divider());
  for (const item of d.items) {
    parts.push(cmd.bold(true));
    parts.push(line(item.name));
    parts.push(cmd.bold(false));
    const right = formatPrice(item.price * item.quantity);
    const left = `  ${item.option ? `${item.option} × ` : "× "}${item.quantity}`;
    parts.push(leftRight(left, right));
  }

  // 금액
  parts.push(divider());
  parts.push(leftRight("상품금액", formatPrice(d.subtotal)));
  if (d.deliveryCost && d.deliveryCost > 0) {
    parts.push(leftRight("배송비", formatPrice(d.deliveryCost)));
  }
  if (d.discount && d.discount > 0) {
    parts.push(leftRight("할인", `-${formatPrice(d.discount)}`));
  }
  parts.push(divider("="));
  parts.push(cmd.size(1, 1));
  parts.push(cmd.bold(true));
  parts.push(leftRight("총 결제", formatPrice(d.totalAmount), LINE_WIDTH / 2));
  parts.push(cmd.bold(false));
  parts.push(cmd.size(0, 0));

  if (d.paymentMethod) {
    parts.push(line(`결제수단: ${d.paymentMethod}`));
  }

  // 담당자 수기 기입란 (counter 포맷)
  if (d.receiptFormat === "counter") {
    parts.push(divider());
    parts.push(line("담당자"));
    parts.push(cmd.feed(1));
    parts.push(divider("_"));
  }

  // QR
  if (d.qrUrl) {
    parts.push(cmd.feed(1));
    parts.push(cmd.align(1));
    parts.push(line(d.qrCaption ?? "QR을 찍어 주문 상세를 확인하세요"));
    parts.push(qrCode(d.qrUrl, { moduleSize: 6, errorCorrection: "M" }));
    parts.push(cmd.feed(1));
    parts.push(cmd.align(0));
  }

  // 출력 시각
  parts.push(divider());
  parts.push(cmd.align(2));
  parts.push(line(`${formatDateTime(new Date().toISOString())} 출력`));
  parts.push(cmd.align(0));

  // 종이 자르기
  parts.push(cmd.feed(3));
  parts.push(cmd.cut());

  return Buffer.concat(parts);
}

/** 진단/단축키용 샘플 영수증 */
export function sampleReceipt(brandName: string): ReceiptData {
  return {
    brandName,
    orderNumber: "TEST-0001",
    createdAt: new Date().toISOString(),
    recipientName: "테스트",
    recipientPhone: "010-0000-0000",
    items: [
      { name: "테스트 상품 A", option: "Red / L", quantity: 1, price: 15000 },
      { name: "테스트 상품 B", option: "Blue / M", quantity: 2, price: 8000 },
    ],
    subtotal: 31000,
    deliveryCost: 3000,
    totalAmount: 34000,
    paymentMethod: "테스트 결제",
    qrUrl: "https://store.dpl.shop/test",
    qrCaption: "프린터 진단 출력",
    copyLabel: "TEST",
  };
}
