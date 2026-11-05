---
name: pptx
description: >
  macOS에서 pptx·ppt·파워포인트 파일이나 기획서 슬라이드를 확인할 때 사용한다. pptx-mcp로 전
  슬라이드의 PNG(PowerPoint for Mac 렌더링)·텍스트·표를 준비하거나 원본 일치가 확인된 공용
  산출물을 재사용하고, 이미지와 텍스트를 함께 검토한다. 최초 전수 추출, 담당 범위 검토, 원본
  구조와 렌더링 차이 확인, 렌더러 기록을 다룬다. pptx 내용 확인·검토는 AionUi 기본 officecli
  스킬보다 이 스킬을 우선한다.
---

> 플랫폼 파생본(macOS): 원본은 Windows 활성본 `~/.claude/skills/pptx/SKILL.md`다. 렌더러 관련 문장(macOS는 PowerPoint COM 대신 AppleScript로 PowerPoint for Mac을 호출, `powerpoint-applescript+pymupdf`)과 해시 명령만 이 플랫폼에 맞게 바꾸고 나머지 절차는 원본 의미를 그대로 옮긴다. 원본이 바뀌면 이 파일도 함께 검토한다. 판단 근거는 ai-guidance-library `CATALOG.md`에 적는다.

# pptx 확인 절차 (macOS)

텍스트 추출만으로 판단하면 도형 배치·표 병합·이미지 안의 글자를 놓친다. 이미지와 텍스트·표를 항상 함께 확인한다.

## officecli와의 경계

- pptx 내용 확인·기획서 검토는 이 스킬의 절차를 따른다. officecli 스킬의 텍스트 추출이나 `view text`만으로 내용을 판단하지 않는다.
- 이 스킬 안에서 officecli는 아래의 표 구조 조회에만 쓴다. 원본을 바꾸지 않는 조회 명령(`get`)만 사용한다. 이 환경에서 officecli를 쓸 수 없으면 표 병합 정보를 미확인으로 기록한다.
- pptx를 새로 만들거나 편집하는 작업은 officecli 스킬을 따른다. 기획서 원본은 편집 요청이 없으면 수정하지 않는다.

## 렌더러와 기록

1. pptx-mcp의 `export_slides_to_images`를 사용한다. macOS에서는 Microsoft PowerPoint for Mac을 AppleScript로 호출해 PDF로 저장한 뒤 PyMuPDF로 PNG를 만든다. 응답의 `renderer`가 `powerpoint-applescript+pymupdf`인지 확인한다. macOS에서는 LibreOffice를 쓰지 않으며, PowerPoint for Mac이 필요하다.
2. 처음 내보낼 때 PowerPoint의 「파일 액세스 부여」 창(`powerpoint-export` 폴더)이나 macOS 권한 창이 뜰 수 있다. 응답이 멈추거나 시간 초과(-1712)로 실패하면 사용자에게 창을 확인해 허용하도록 요청한다. 자동화 권한 거부(-1743)면 시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 Microsoft PowerPoint를 켜도록 안내한다.
3. PowerPoint 미설치(`requires Microsoft PowerPoint for Mac`)·권한 거부처럼 렌더러를 쓸 수 없다는 오류와, 파일 손상·암호 보호·잘못된 슬라이드 번호처럼 렌더러와 무관한 오류를 구분해 원인을 보고한다. 다른 렌더러로 숨기지 않는다.
4. 사용한 렌더러(`powerpoint-applescript+pymupdf` 등)를 결과와 산출물 기록에 남긴다. PNG 수가 원본 슬라이드 수와 다르면 숨긴 슬라이드가 PDF에서 빠졌을 수 있으므로 PNG와 슬라이드 번호의 대응을 확인한다.
5. 렌더링할 수 없으면 텍스트만으로 내용을 확정하지 말고, 이미지 미확인 범위와 PowerPoint가 있는 PC에서의 확인 필요성을 보고한다.

## 최초 준비 또는 새 원본

1. pptx-mcp로 원본을 열고 위 렌더러로 모든 슬라이드를 PNG로 저장한다.
2. pptx-mcp(`extract_presentation_text` 또는 `extract_slide_text`)로 모든 슬라이드의 텍스트를 추출한다. 이 도구의 `table_text`는 빈 셀을 빼고 병합 정보를 주지 않는다. 그래서 `has_tables`가 참인 슬라이드는 `officecli get <원본> "/slide[N]/table[K]" --depth 2 --json`으로 행·열 위치와 `colspan`·`rowspan`(이어지는 셀은 `hmerge`·`vmerge`)을 함께 확보해 표 구조로 기록한다.
3. 전 슬라이드 PNG를 사용 가능한 이미지 열람 도구로 직접 열어 텍스트·표와 함께 확인한다. 도구 이름을 특정 AI의 `Read`로 한정하지 않는다.
4. 원본 주소·개별 버전·해시·전체 슬라이드 수, PNG·텍스트·표 목록과 슬라이드 대응, 사용한 렌더러, 접근 경로를 함께 남긴다. 해시는 원본 파일 바이트의 SHA-256이다(`shasum -a 256`). Dooray 첨부는 `dooray_project_download_attachment`로 받은 파일로 계산하고, 알고리즘 이름을 값과 함께 적는다. 여러 기획서는 각각 식별하며 추가 원본을 기존 원본의 대체본으로 간주하지 않는다.

## 공용 산출물을 받는 경우

1. 요청 기준 원본의 버전·해시가 산출물의 출처와 일치하는지 확인한다. 해시는 위와 같은 방식(원본 파일 SHA-256)으로 계산해 비교한다. 파일명이나 이전 AI의 요약만으로 최신 원본이라고 판단하지 않는다.
2. 필요한 슬라이드의 PNG·텍스트·표와 원본 위치 대응이 빠짐없이 있고 현재 작업공간에서 읽을 수 있는지 확인한다. 기록된 렌더러가 PowerPoint 렌더러(`powerpoint-applescript+pymupdf`, `powerpoint-com`)가 아니면 렌더링 차이 가능성을 판단에 반영한다.
3. 조건을 충족하면 기존 산출물을 우선 재사용한다. 재사용만을 위해 pptx-mcp로 다시 열거나 재추출하지 않는다.
4. 자료가 없거나 불일치·손상됐으면 원인을 알리고 필요한 범위만 pptx-mcp로 다시 준비한다. 새 원본은 최초 준비 절차를 적용한다. 원본을 확인할 수 없으면 최신성·완전성을 추측하지 말고 미확인 범위를 보고한다.

공통 분석 결과를 재사용해도 원본 이미지의 직접 확인, 담당 요구사항 상세 검토와 현재 구현 감사는 생략하지 않는다. 기록·공유 또는 외부 도구 쓰기는 현재 작업에서 승인된 범위에 한한다.

## 직접 확인할 범위와 차이 처리

- 전체 기획 분석·공통 최초 준비·최종 전수 검증은 모든 슬라이드를 직접 확인한다.
- 담당 문서·하위 업무의 제한된 검토는 담당 슬라이드 전체와 판단에 필요한 공통·연관 슬라이드를 직접 확인한다. 확인하지 않은 나머지를 전수 검토했다고 보고하지 않는다.
- 이미지와 텍스트·표가 다르면 원본 구조와 렌더링 차이를 기록하고 PowerPoint 직접 확인이 필요한지 명시한다.
