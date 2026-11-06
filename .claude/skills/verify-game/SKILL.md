---
name: verify-game
description: 주식 투자 게임이 정상 동작하는지 한 번에 검증한다. API 테스트(node --test), 서버 재시작, 브라우저에서 5턴 전체 플레이, 테스트 기록 정리까지 수행한다. 코드 수정/리팩토링 후 "검증해줘", "잘 돌아가는지 확인", "verify" 요청 때 사용.
---

# 게임 검증

코드를 바꾼 뒤 게임이 그대로 동작하는지 확인한다. 아래 순서대로 실행하고 마지막에 결과를 표로 보고한다. 실패한 단계는 숨기지 말고 출력 그대로 알린다.

## 1. API 테스트

```bash
node --test test/
```

- 통과/실패 개수를 기록한다. 실패하면 이후 단계로 가기 전에 원인을 먼저 보고한다.
- 테스트는 임시 DB와 비어 있는 임의 포트를 쓰므로 실제 `game.db`와 3456 서버에 영향이 없다.

## 2. 서버 재시작

`src/`나 `server.js`를 바꿨다면 반드시 재시작해야 반영된다. 3456 포트의 기존 서버만 종료하고 다시 띄운다(다른 포트의 프로세스는 건드리지 않는다. 3000 포트는 다른 프로그램 것이다).

```powershell
$p = (Get-NetTCPConnection -LocalPort 3456 -State Listen -ErrorAction SilentlyContinue).OwningProcess; if ($p) { Stop-Process -Id $p -Force }
Start-Process node -ArgumentList 'server.js' -WorkingDirectory '<프로젝트 경로>' -WindowStyle Hidden
```

`GET http://localhost:3456/api/rankings`가 200이면 정상이다.

## 3. 브라우저 플레이스루

내장 브라우저로 `http://localhost:3456`을 열고 `javascript_tool`로 한 판을 끝까지 진행한다. 플레이어 이름은 반드시 `verify-` 로 시작해야 한다(4단계에서 이 이름만 지운다).

```js
const w = ms => new Promise(r => setTimeout(r, ms));
let confirms = 0, alerts = [];
window.confirm = () => { confirms++; return true; };
window.alert = m => alerts.push(m);
document.getElementById('name').value = 'verify-' + Date.now();
document.getElementById('startBtn').click(); await w(400);
document.querySelector('tr.row').click();
document.getElementById('buyBtn').click(); await w(300);
let lines = 0;
for (let i = 0; i < 5; i++) {
  document.getElementById('endBtn').click(); await w(400);
  if (i === 0) lines = document.querySelectorAll('#chart polyline').length;
}
JSON.stringify({ lines, confirms, alertCount: alerts.length, alert: alerts[0],
  rankTop: document.getElementById('rankBody').innerText.slice(0, 120),
  startVisible: !document.getElementById('start').classList.contains('hidden') });
```

기대 결과:

| 항목 | 기대값 |
|---|---|
| `lines` | 10 (종목별 그래프 선) |
| `confirms` | 4 (첫 턴은 매수했으므로 확인창 없음, 나머지 4턴은 무거래라 확인창 표시) |
| `alertCount` | 1 (게임 종료 알림) |
| `startVisible` | true (종료 후 시작 화면 복귀) |
| `rankTop` | 방금 플레이한 `verify-...` 기록 포함 |

추가로 `read_console_messages`(onlyErrors)로 콘솔 오류가 없는지 확인한다.

## 4. 테스트 기록 정리

검증용 게임(`verify-` 접두사)만 삭제한다. 다른 사람의 실제 플레이 기록과 랭킹은 절대 지우지 않는다.

```bash
node .claude/skills/verify-game/cleanup.js
```

삭제된 게임 수와 남은 랭킹 수를 출력한다.

## 5. 보고

단계별로 통과/실패를 표로 정리하고, 확인하지 못한 것(예: 그래프 모양을 눈으로 보지 않음)을 명시한다.
