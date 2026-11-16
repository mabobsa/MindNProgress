# Dooray 요청 외부 모듈 연결 지점

MnP 서버는 Dooray API를 직접 조회한다. 그런데 API 점검·차단처럼 Dooray API를 쓸 수 없는 기간이 있다. 이 문서는 그런 기간에 서버 코드를 바꾸지 않고 이 PC에서만 다른 연결 방법을 끼워 넣는 연결 지점을 설명한다. 연결 방법의 구현은 이 저장소에 두지 않는다.

## 대상

데이터 폴더 설정이 있으면 MnP 서버가 직접 부르는 Dooray 조회가 모두 연결 지점을 거친다.

- Dooray 업무·Wiki 링크 미리보기와 제목, 댓글 작성자(`server/lib/doorayTasks.mjs`)
- Dooray 업무 대응의 프로젝트 목록과 멘션·담당·참조 수집(`server/lib/doorayMentions.mjs`)

AI 대화가 쓰는 Dooray MCP는 MnP 밖의 등록이라 이 연결 지점과 무관하다.

## 설정

데이터 폴더(`server/data`, 저장소에 포함하지 않음)에 `_dooray-transport.json`을 둔다.

```json
{ "module": "C:\\절대\\경로\\bridge.cjs" }
```

- 모듈은 `fetch(input, init, { fallbackFetch })`를 내보내야 한다(ES 모듈 export 또는 CommonJS `module.exports`).
  - 반환값은 Dooray API와 같은 응답이다.
  - `fallbackFetch`는 원래 fetch다. 모듈이 원래 Dooray API로 넘길 때 쓴다.
- 요청은 원래와 같은 Dooray API 주소와 인증 헤더로 전달된다. 모듈이 무시하거나 바꿔 처리한다.
- MnP는 요청마다 설정 파일을 다시 읽는다. 파일을 만들거나 지우면 재시작 없이 바로 바뀐다.
- 같은 경로의 모듈은 한 번만 불러온다. 모듈 코드를 고쳤다면 MnP를 다시 시작해야 반영된다.
- 다음 경우에는 경고를 한 번 남기고 원래 Dooray API를 쓴다. 요청 자체는 실패시키지 않는다.
  - 설정 파일이 깨졌을 때
  - 경로가 절대 경로가 아닐 때
  - 모듈을 불러오지 못했을 때
  - 모듈이 `fetch`를 내보내지 않을 때

## 되돌리기

- `_dooray-transport.json`을 지우면 다음 요청부터 원래 Dooray API를 쓴다.
- 연결 지점 코드는 남겨 둬도 설정이 없을 때 원래 동작과 같다.
- 외부 모듈이 자체 전환 상태를 갖고 있다면 그 상태로 전환할 수도 있다(예: 모듈이 원래 fetch로 넘기는 모드). 이 경우 설정 파일은 그대로 둔다.

## 주의

- `module` 경로의 코드는 MnP 서버 권한으로 실행되므로, 이 PC에서 신뢰하는 코드만 지정한다.
- 연결 방법 구현과 그 접속 정보는 이 공개 저장소에 올리지 않는다.
