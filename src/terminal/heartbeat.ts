import { net } from "electron";
import type { TerminalAdapter } from "./types";

// 카드단말 하트비트 — 어댑터 ping 결과를 서버에 주기 보고한다.
// 서버는 heartbeatAt(앱 생존)과 readerConnectedAt(리더기 정상)을 나눠 기록해
// 관리자 카드단말 탭에서 단말·리더기 상태를 구분해 보여준다. 단말 쿠키 인증.

const HEARTBEAT_INTERVAL_MS = 60_000;

export interface HeartbeatDeps {
  adapter: TerminalAdapter;
  /** { baseUrl, tenantName } — 미설정(설치 전)이면 null */
  getTarget: () => { baseUrl: string; tenantName: string } | null;
}

export function startTerminalHeartbeat(deps: HeartbeatDeps): NodeJS.Timeout {
  let running = false; // ping·POST 가 주기를 넘겨도 beat 가 중첩되지 않게

  const beat = async () => {
    if (running) return;
    const target = deps.getTarget();
    if (!target) return;
    running = true;
    try {
      const { connected } = await deps.adapter.ping();
      await net.fetch(`${target.baseUrl}/api/terminal/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ tenant: target.tenantName, connected }),
      });
    } catch {
      // 서버 미도달 — 다음 주기에 재시도 (하트비트 공백 자체가 상태 신호다)
    } finally {
      running = false;
    }
  };

  beat();
  return setInterval(beat, HEARTBEAT_INTERVAL_MS);
}
