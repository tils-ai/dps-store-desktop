import Store from "electron-store";

export interface PrinterConfig {
  /** 시리얼 포트 경로 (Windows: "COM2", macOS/Linux: "/dev/tty.usbserial-XXX") */
  com: string;
  /** baud rate (SCP-380CII 등 9600 기본) */
  baud: number;
  /** 접수증 출력 사용 여부 — false면 호출돼도 no-op */
  enabled: boolean;
}

export interface TerminalConfig {
  /** 카드단말 승인 데몬(KSnCAT) 인터페이스 포트 (0 = 미설정 → 단말 결제 비활성) */
  port: number;
  /** 승인 데몬 호스트 (기본 로컬) */
  host: string;
  /** 전자서명 유무 — "X": 무서명(기본), "K": KSnCAT 서명창, "T": 화면터치, " ": KSnCAT 설정 위임 */
  signMode?: "X" | "K" | "T" | " ";
  /** 부가세 필드 — "kscat": KSnCAT 자동부가세 위임(기본), "explicit": 과세분 계산해 전송 */
  taxMode?: "kscat" | "explicit";
  /**
   * 키오스크 연동 모드(전문의 암호화 여부 "K") — 기본 false.
   *
   * 켜면 KSnCAT 이 안내창을 띄우지 않고 윈도우 핸들로 Windows 메시지를 보내는데,
   * Electron 이 그 메시지를 받지 않아 전문 오류(1001)로 거절된다. KSnCAT 쪽 연동이
   * 확인된 뒤에만 켠다.
   */
  kioskMode?: boolean;
  /** 거래구분 — 기본 "IC"(신용 IC). MS 카드까지 받아야 하면 "MI" */
  txType?: "MI" | "IC" | "MS";
  /** 암호화 여부 — 기본 "A"(ACK·EOT 미전송). ""(공백)으로 되돌려 시험할 수 있다 */
  encryptFlag?: "" | "A";
}

export interface TenantConfig {
  id: string;
  tenantName: string;
  brandName: string;
  domain: string | null;
  baseUrl: string;
  kiosk: boolean;
  installedAt: string;
  schemaVersion: 1;
  /** 키오스크 접수증 프린터 설정. 미설정 시 출력 비활성 */
  printer?: PrinterConfig;
  /** 카드단말(VAN 직결) 설정. 미설정 시 단말 결제 비활성 */
  terminal?: TerminalConfig;
}

interface Schema {
  tenant?: TenantConfig;
}

const store = new Store<Schema>({ name: "config" });

export const DEFAULT_PRINTER_CONFIG: PrinterConfig = {
  com: "COM2",
  baud: 9600,
  enabled: false,
};

export const DEFAULT_TERMINAL_CONFIG: TerminalConfig = {
  port: 0,
  host: "127.0.0.1",
};

export function loadConfig(): TenantConfig | null {
  return store.get("tenant") ?? null;
}

export function saveConfig(cfg: TenantConfig): void {
  store.set("tenant", cfg);
}

export function resetConfig(): void {
  store.delete("tenant");
}

export function hasConfig(): boolean {
  return Boolean(store.get("tenant"));
}

/** printer 설정만 부분 업데이트. tenant config가 없으면 no-op */
export function updatePrinterConfig(patch: Partial<PrinterConfig>): PrinterConfig | null {
  const tenant = loadConfig();
  if (!tenant) return null;
  const next: PrinterConfig = { ...DEFAULT_PRINTER_CONFIG, ...tenant.printer, ...patch };
  saveConfig({ ...tenant, printer: next });
  return next;
}

export function getPrinterConfig(): PrinterConfig {
  const tenant = loadConfig();
  return { ...DEFAULT_PRINTER_CONFIG, ...(tenant?.printer ?? {}) };
}

/** terminal 설정만 부분 업데이트. tenant config가 없으면 no-op */
export function updateTerminalConfig(patch: Partial<TerminalConfig>): TerminalConfig | null {
  const tenant = loadConfig();
  if (!tenant) return null;
  const next: TerminalConfig = { ...DEFAULT_TERMINAL_CONFIG, ...tenant.terminal, ...patch };
  saveConfig({ ...tenant, terminal: next });
  return next;
}

export function getTerminalConfig(): TerminalConfig {
  const tenant = loadConfig();
  return { ...DEFAULT_TERMINAL_CONFIG, ...(tenant?.terminal ?? {}) };
}
