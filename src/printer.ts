/**
 * 키오스크 접수증 프린터 (Sewoo SCP-380CII 등 ESC/POS over serial).
 *
 * - serialport로 COM 포트 직접 오픈 → ESC/POS 바이트 송신
 * - 포트 객체는 캐시. 설정(com/baud) 변경 시 재연결
 * - 동시 출력 충돌 방지를 위해 단순 직렬 큐
 */

import { SerialPort } from "serialport";
import { getPrinterConfig, loadConfig, updatePrinterConfig, type PrinterConfig } from "./config";

let cached: { port: SerialPort; key: string } | null = null;

/** com/baud 조합 변경 감지용 키 */
function configKey(cfg: PrinterConfig): string {
  return `${cfg.com}|${cfg.baud}`;
}

async function openPort(cfg: PrinterConfig): Promise<SerialPort> {
  if (cached?.key === configKey(cfg) && cached.port.isOpen) {
    return cached.port;
  }
  if (cached) {
    await new Promise<void>((resolve) => cached!.port.close(() => resolve()));
    cached = null;
  }
  const port = new SerialPort({
    path: cfg.com,
    baudRate: cfg.baud,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
    autoOpen: false,
  });
  await new Promise<void>((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  });
  cached = { port, key: configKey(cfg) };
  return port;
}

let pending: Promise<unknown> = Promise.resolve();

/** ESC/POS 바이트를 프린터로 송신. enabled=false면 throw */
export async function sendBytes(bytes: Buffer): Promise<void> {
  const cfg = getPrinterConfig();
  if (!cfg.enabled) {
    throw new Error("printer disabled");
  }
  // 직렬화 — 다중 호출이 충돌하지 않게
  const job = pending.then(async () => {
    const port = await openPort(cfg);
    await new Promise<void>((resolve, reject) => {
      port.write(bytes, (err) => {
        if (err) return reject(err);
        port.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()));
      });
    });
  });
  pending = job.catch(() => undefined);
  await job;
}

/** 앱 종료/리셋 시 호출. 캐시된 포트 안전하게 닫음 */
export function closePrinter(): void {
  if (cached?.port.isOpen) cached.port.close();
  cached = null;
}

/** 진단용 — 포트 목록 조회 (Windows: COMx, *nix: /dev/tty.*) */
export async function listPorts(): Promise<{ path: string; manufacturer?: string }[]> {
  const list = await SerialPort.list();
  return list.map((p) => ({ path: p.path, manufacturer: p.manufacturer }));
}

export interface WarmUpResult {
  ok: boolean;
  /** 설정된 적 없는 단말이라 건너뜀 */
  skipped?: boolean;
  enabled?: boolean;
  com?: string;
  error?: string;
}

const WARMUP_ATTEMPTS = 3;
const WARMUP_RETRY_MS = 1000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 부팅 시 프린터 자가복구 + 워밍업.
 *
 * 배경: 일체형(키오스크+영수증) 단말은 COM 포트가 상시 연결돼 있는데도, 앱을 껐다 켜면
 * 결과 페이지 자동 출력이 안 되고 운영자가 매번 진단 단축키(Ctrl+Shift+Alt+P)로 다시
 * 활성화해야 하는 사례가 있었다. 관리 측면에서 부적절한 UX다.
 *
 * 동작:
 *  - 이전에 한 번이라도 설정된 단말(tenant.printer 존재)만 대상. 미설정 단말은 skip —
 *    설정 없는 PC에서 기본 COM2를 임의로 열지 않는다.
 *  - 설정된 com이 감지 포트 목록에 있으면 포트를 미리 열어 캐시(첫 출력 지연 제거)하고
 *    enabled=true로 자가복구한다. 다음 결제 완료 시 별도 조작 없이 자동 출력된다.
 *  - 콜드 부팅 직후 시리얼 enumeration 지연을 감안해 몇 차례 재시도한다.
 *  - 실패해도 다이얼로그 없이 결과만 반환 — 호출 측에서 로그만 남기고 부팅 흐름을 막지 않는다.
 */
export async function warmUpPrinter(): Promise<WarmUpResult> {
  const tenant = loadConfig();
  if (!tenant?.printer) return { ok: false, skipped: true };

  const cfg = getPrinterConfig();
  let lastError = "";
  for (let attempt = 1; attempt <= WARMUP_ATTEMPTS; attempt++) {
    try {
      const ports = await listPorts();
      if (!ports.some((p) => p.path === cfg.com)) {
        lastError = `port ${cfg.com} not detected`;
      } else {
        await openPort(cfg); // 캐시 유지 → 첫 출력 워밍업
        if (!cfg.enabled) updatePrinterConfig({ enabled: true }); // 비활성으로 돌아간 설정 자가복구
        return { ok: true, enabled: true, com: cfg.com };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < WARMUP_ATTEMPTS) await delay(WARMUP_RETRY_MS);
  }
  return { ok: false, error: lastError, com: cfg.com };
}
