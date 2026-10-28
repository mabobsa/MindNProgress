# Aion Android 알리미로 푸시 보내기

`POST /api/integrations/aionui/push-notifications`는 로그인 사용자 또는 기존 인증·AI 귀속을 검증한 API 호출자의 요청을 Windows AionUi로 전달한다. 수신 PC의 AionUi에서 **휴대폰 푸시 사용**과 **MnP 알림 받기**를 켜고 휴대폰을 연결해야 한다. 새 MnP 전송 규격을 지원하는 Android 앱으로 먼저 업데이트한다. Firebase 설정과 휴대폰 연결은 기존 것을 사용한다.

## 호출

MnP에 로그인한 브라우저에서 다음처럼 호출한다. 다른 프로그램에서는 기존 MnP 인증과 사용자 귀속 절차를 그대로 사용한다. 호출자가 `userId`, 발신자 식별자나 휴대폰 토큰을 지정하는 방식은 제공하지 않는다.

```javascript
const response = await fetch('/api/integrations/aionui/push-notifications', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    machineId: 'my-windows-pc',
    eventId: 'review-card-123-request-1',
    kind: 'choice',
    title: '작업 결과 검토 요청',
    body: '작업 결과와 선택지 전체입니다.',
    revision: 1,
  }),
});
console.log(response.status, await response.json());
```

필수 항목은 등록된 `machineId`, 요청별 고유 `eventId`, `kind`(`choice`, `failure`, `info`), `title`(최대 120자), `body`(최대 16,000 UTF-16 코드 단위)다. `revision`은 기본 1인 양의 정수이며 갱신 시 증가시킨다. 같은 이벤트의 재시도는 같은 ID와 개정 번호를 사용하고, 별개 요청은 새 ID를 사용한다. `eventId`·`mapId`·`cardId`는 영문·숫자·`_`·`-`로 된 160자 이하 값이다.

선택 항목 `mapId`·`cardId`는 관련 업무 식별자다. `webUrl`은 서버의 공개 주소와 같은 출처의 HTTPS 링크만 허용한다. 휴대폰에서 접근 가능한 주소를 사용한다. 제목·본문에 그룹과 카드 이름을 넣으면 별도 조회 없이 휴대폰에서 표시할 수 있다.

## 권한과 경로

- 편집자는 본인 소유 서브 머신, 관리자는 관리 가능한 머신으로 보낸다. 메인 머신은 기존 머신 관리 정책에 따라 관리자만 사용할 수 있다.
- 서버 운영자가 `MNP_MOBILE_PUSH_MAIN_USER_ID`에 계정 ID 한 개를 지정하면 해당 편집자도 메인 PC의 푸시 발송만 사용할 수 있다. 머신 관리·Runner 토큰 발급 권한은 추가되지 않으며 요청 본문으로 이 권한을 지정할 수 없다.
- 메인 PC에서는 사용자 로컬 `%LOCALAPPDATA%/AionUiPush/mobile-push-relay.json`을 읽어 루프백 중계로 보낸다. 다른 계정으로 MnP를 실행하면 같은 사용자 프로필의 중계에 연결할 수 없다.
- 서브 PC는 기존 오퍼레이션 큐와 Runner를 사용한다. AionUi 내장 Runner와 독립 CLI Runner 모두 `/api/internal/mobile-push/mnp` 요청을 해당 PC의 로컬 중계로 전달한다. LAN 수신 포트는 열지 않는다.
- 비표준 설치는 양쪽에 같은 `AIONUI_PUSH_RELAY_FILE`을 설정할 수 있다. 파일의 실행별 중계 토큰은 비공개로 취급한다. Firebase 서비스 계정·FCM 토큰은 MnP에 저장하지 않는다.
- AionUi 로그인 사용자별 설정·휴대폰 연결·전송 이력을 사용한다. MnP 사용자와 서버 출처를 서버가 해시해 이벤트 ID를 분리한다.

## 결과와 표시

`202`, `state: 'queued'`, `delivery: 'queued'`, `receivedOnPhone: false`는 AionUi 전송 큐 접수다. 실제 휴대폰 수신 확인으로 해석하지 않는다. `401`은 인증 필요, `403`은 권한 부족, `400`은 잘못된 입력이다. `disabled`는 PC 사용 설정 꺼짐, `device`는 활성 휴대폰 없음, `PUSH_RELAY_UNAVAILABLE`은 로컬 중계 없음, `RUNNER_NOT_CONFIGURED`·`RUNNER_OFFLINE`은 원격 Runner 연결 문제다. 이후 FCM 실패는 AionUi 설정의 전송 오류로 확인한다.

미리보기가 꺼져 있으면 업무 제목·본문·링크를 Firebase로 보내지 않는다. Android는 기본 MnP 문구를 표시한다. 미리보기가 켜져 있으면 UTF-8 전송 용량에 맞춰 본문을 자르고 생략 부호를 붙인다. 기존 AionUi 알림 형식과 저장 이력은 유지한다.

Android는 별도 업무 아이콘, `[MnP]` 제목, 청록 강조색, **MnP 업무 알림** 채널과 앱 내부 MnP 배지를 사용한다. 소리·진동은 Android 채널 설정에서 따로 바꿀 수 있다. 알림 열람·삭제는 MnP 승인·완료 처리와 별개다. 후속 개정은 무음이며 이미 읽거나 없앤 알림을 다시 띄우지 않는다.

## Dooray AI 대응 단계 알림

‘AI 대응 제안 설정’의 ‘추가 정보 필요·승인 대기 시 푸시 받기’를 켜고 ‘휴대폰이 연결된 PC’를 선택한다. 알림 PC는 AI 실행 머신과 달라도 된다. 계정별로 저장하며 새 제안과 다시 제안받기부터 적용한다.

서버는 `needs-input`·`needs-approval`로 전환할 때 대응 기록과 발송 대기를 함께 저장한다. 기존 대기 기록의 조회나 배포만으로 과거 알림을 일괄 발송하지 않는다. 실제 전송은 저장 잠금과 AI 진행 큐 밖에서 최대 두 건씩 처리한다. 같은 발송은 동일한 이벤트 ID·개정 번호를 사용하며 재제안 회차나 제안 내용이 바뀌면 새 이벤트로 알린다.

외부 연결 실패는 15초·1분·3분·10분 간격으로 최대 5회, 최초 기록부터 30분 안에서 재시도한다. 전송 중 재시작하면 1분 뒤 동일 이벤트로 재시도한다. 권한·설정 오류는 즉시 실패로 남긴다. 이미 답변·승인·완료한 요청의 대기 알림은 취소하며, 외부로 이미 전달 중인 알림은 회수할 수 없다. ‘푸시 접수됨’은 휴대폰 수신 완료가 아니다.

공개 주소가 HTTPS이면 `/?doorayResponseId=요청ID` 링크로 로그인한 사용자의 해당 대응을 연다. 알림을 여는 동작은 AI 실행이나 승인이 아니다. HTTP 공개 주소에서는 링크 없이 업무 제목과 질문·승인 범위를 보낸다. 실제 휴대폰 표시 내용은 AionUi의 미리보기 설정과 전송 용량 제한을 따른다.

## 집중 검증

```powershell
node --test tests/mobile-push.test.mjs tests/mobile-push-api.test.mjs tests/dooray-response-push.test.mjs tests/dooray-response-push-api.test.mjs
```

API 검증은 임시 데이터 디렉터리·임시 포트의 격리 서버와 가짜 로컬 중계를 사용한다. 운영 MnP를 재시작하거나 실제 Firebase·휴대폰으로 발송하지 않는다. 자동 발송할 업무 이벤트의 선택은 이 API를 호출하는 기능에서 결정한다.
