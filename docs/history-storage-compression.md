# 변경 이력·저장 복구 사본 압축 보관

2026-11-09 기준 `server/data` 19.85GB 중 변경 이력(`_history`)이 10.43GB, 저장 복구 기록(`_storage-transactions`)의 변경 후 파일 사본(`image-*`)이 8.20GB였다. 주간 백업은 이 데이터를 통째로 복사·해시·압축해 예약 작업의 10분 제한을 넘겼다. 두 기록은 모두 특정 상황에서만 읽으므로, 내용을 줄이지 않고 압축해 보관하고 읽을 때 푼다. 지우거나 솎는 기록은 없다.

## 변경 이력

- 문서 내용이 바뀌어 저장될 때마다 `archiveMapRevision`이 저장 전 문서 전체를 `_history/<문서ID>/<이력ID>.json.br`(brotli, 품질 4)로 남긴다. 3MB 문서 기준 압축 약 13ms, 해제 약 4ms이며 크기는 원문의 약 10~25%다.
- 읽는 곳은 `server/lib/revisionFiles.mjs`의 같은 규칙을 쓴다. 이력 목록·복원(`listMapRevisions`·`readMapRevision`), 기동 시 생성 정보 보정, 일일 백업 보정(`dailyBackupHistory.mjs`), 이미지 정리(`imageAssetCleanup.mjs`)다.
- 압축 이전 이력과 예전 백업에서 복원한 이력(`<이력ID>.json`)도 계속 읽는다. 같은 ID가 두 형식으로 있으면 압축본을 쓴다.
- 이미지 정리가 압축 이력을 빠뜨리면 그 이력에서만 참조하는 이미지를 미참조로 보고 지우므로, 이력 폴더는 두 형식을 모두 읽는다(`tests/history-compression.test.mjs`).
- 백업의 날짜별 선별(`scripts/backup-data.ps1`)은 파일 이름의 이력 ID로 시각을 읽으므로 압축 이력도 내용을 풀지 않고 같은 규칙을 적용한다.

### 이력 목록

- 이력 ID 앞부분이 저장 시각이므로 `listMapRevisions`는 파일 이름만으로 최신순 정렬하고, 요청한 쪽(`offset`부터 `limit`개)의 이력만 읽는다. 2026-11-09 운영 이력 25,066개에서 이 순서는 `archivedAt` 순서와 모두 같았다.
- 예전에는 모든 이력을 읽어 정렬해, 이력 1,197개 문서의 목록이 약 38초 걸려 MCP 30초 제한을 넘었다. 이제는 요청한 쪽만 읽으므로 `limit` 50 기준 약 1.5초다.
- `offset`은 정렬한 이력 파일의 위치다. 다른 문서의 이력·잘못된 형식·읽을 수 없는 파일은 건너뛰고 `[History list skipped]`로 기록하며, 그때만 한 쪽이 `limit`보다 짧다. 예전에는 파일 하나가 손상돼도 목록 전체가 실패했다.
- 이력 ID 규칙 밖의 이름은 그 파일만 열어 `archivedAt`으로 자리를 정한다.
- `snapshotSha256`은 복원 시점의 정규화 규칙과 같아야 하므로 저장하지 않고 조회할 때 계산한다.
- 기동 때 일일 백업 보정은 손상된 이력을 오류로 알리고 기동을 멈춘다. 원문 JSON 손상과 압축본 손상 모두 같다(기존 동작).

### 기존 이력 변환

`scripts/compress-revision-history.mjs`가 기존 `.json` 이력을 `.json.br`로 바꾼다.

1. 먼저 시험 실행으로 개수·용량·예상 크기를 확인한다. 아무것도 바꾸지 않는다.
   `node scripts/compress-revision-history.mjs --data-dir server/data`
2. 최신 백업이 있는지 확인하고, `scripts/mnp-runtime.ps1 -Action stop`으로 서버를 멈춘다. 서버가 응답하면 `--apply`는 거부된다(`--server-url`로 확인 주소 지정).
3. `node scripts/compress-revision-history.mjs --data-dir server/data --apply`
4. 서버를 `-Action start`로 시작한다.

원문 바이트를 그대로 압축하고, 디스크의 압축본을 다시 읽어 풀었을 때 원문과 바이트 단위로 같을 때만 원문을 지운다. 수정 시각은 원문 것으로 맞춘다. JSON이 아니거나 같은 ID의 압축본 내용이 다르면 그대로 두고 `skipped`로 보고한다(종료 코드 2). 중간에 끊겨 다시 실행하면 이미 쓴 압축본은 내용이 같을 때만 원문을 정리한다. 변환 뒤 첫 일일 백업 보정은 파일 크기가 바뀌어 이력을 한 번 다시 읽는다.

## 저장 복구 사본

- 저장 journal은 커밋 표시 전에 변경 후 파일 전체를 `image-N`으로 쓰고, 반영 뒤 `applied.json`을 남긴다. `image-N`은 커밋과 반영 사이에 서버가 꺼졌을 때 redo하는 데만 쓰며, `applied.json`이 있는 기록은 다시 반영하지 않는다(`docs/api-storage/contract-v1.md` 4절).
- 반영이 끝나면 `image-N`을 백그라운드 대기열에서 하나씩 brotli로 압축해 `image-N.br`로 바꾼다. 압축본을 풀어 원문과 같을 때만 원문 사본을 지우고, 실패하면 원문 사본을 그대로 둔다. 저장 요청의 잠금·응답과 무관하므로 저장 속도에 영향이 없다. 12MB 위임 상태 사본 기준 원문의 약 8%가 된다.
- 결과 보존 기간(완료 후 24시간)과 정리 규칙은 바뀌지 않는다. 기동 때 이미 반영된 기록(압축 도입 전 기록 포함)은 기동 1분 뒤부터 같은 대기열로 압축한다.
- redo는 원문 사본을 읽고, 압축본만 남은 경우에도 풀어서 같은 해시 검사를 한다.
- `MNP_JOURNAL_IMAGE_COMPRESSION=0`이면 압축하지 않는다. `MNP_JOURNAL_IMAGE_COMPACTION_DELAY_MS`로 기동 후 대기 시간(기본 60000)을 바꿀 수 있다.

## 백업

- 백업은 시작할 때 이전 실행이 강제 종료로 남긴 6시간 지난 복사본(`.staging-*`)과 미완성 ZIP(`*.partial.zip`)을 정리한다. 정리에 실패하면 경고만 하고 백업은 계속한다.
- 압축 이력·사본은 ZIP 안에서 거의 더 줄지 않으므로 ZIP 크기는 크게 바뀌지 않는다. 대신 복사·해시·압축할 양이 줄어 서버 정지 시간과 백업 시간이 줄어든다.
