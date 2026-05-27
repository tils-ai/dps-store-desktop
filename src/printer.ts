/**
 * 키오스크 접수증 프린터 (Sewoo SCP-380CII 등 ESC/POS over serial).
 *
 * - serialport로 COM 포트 직접 오픈 → ESC/POS 바이트 송신
 * - 포트 객체는 캐시. 설정(com/baud) 변경 시 재연결
 * - 동시 출력 충돌 방지를 위해 단순 직렬 큐
 */

import { SerialPort } from "serialport";
import { getPrinterConfig, type PrinterConfig } from "./config";

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
