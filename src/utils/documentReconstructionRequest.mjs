export function buildReconstructionRequestPrompt(request) {
  if (!/^reorg-request-[a-zA-Z0-9-]+$/.test(request?.id ?? '')) throw new Error('문서 정리 요청 ID가 필요합니다.')
  return [
    '사용자가 문서·그룹 우클릭의 문서 정리 화면에서 요청한 분석 전용 작업입니다.',
    `요청 ID: ${request.id}`,
    '1. mindnprogress_get_reconstruction_request({requestId})로 실제 요청 범위·목적·현재 기준·새 기획 출처·요청사항과 분석 승인 기록을 읽으세요. 시작 카드는 문맥 진입점일 뿐 정리 대상 전체가 아닙니다.',
    '2. 요청의 mapIds로 mindnprogress_get_reconstruction_context를 호출하고 guide, sources, groupBaselines를 확인하세요. 각 문서의 원문·공유 지식·댓글·관계와 최신 그룹 기준·사용자 승인 범위를 읽으세요. 기획 갱신은 새 원본과 현재 구현의 차이까지 조사합니다.',
    '3. 요청 mode, baseline, newSource와 정확히 같은 대상의 전환안을 작성하세요. 총괄 문서와 요청 밖 문서는 변경하지 않습니다. 미완료 조건·대기·현재 유효 지식을 보존하고 전수 카드 대응표와 처리 이유를 포함하세요. 새 업무 조건이 여러 개면 결과 중심 체크리스트를 제안하고 별도 하위 업무와 중복하지 않습니다.',
    '4. mindnprogress_preview_reconstruction으로 검증한 뒤 mindnprogress_submit_reconstruction_proposal({requestId,baseRevision,plan})로 이 요청의 제안함에 제출하세요. baseRevision은 요청에서 읽은 revision입니다. plan.approval은 넣지 마세요. 제출은 사용자 검토용 산출물 저장일 뿐 문서 적용이 아닙니다.',
    '5. 사용자에게 변경 이유·보존/통합/과거 근거 분류·누락과 상충 여부·완료 조건을 설명하고 적용 승인을 기다리세요. 확정할 수 없는 사항은 먼저 대화에서 질문하고 임의의 결론을 제출하지 마세요.',
    '허용: 읽기 전용 조사, 미리보기 검증, 이 요청의 제안함에 정리안 제출.',
    '금지: 문서·카드·댓글·공유 지식·상태·대기 항목 변경, 문서 생성·보관·삭제·전환 적용, 코드/Prefab 개발, 추가 AI 위임. 실제 적용은 사용자가 MnP 화면에서 별도로 검토하고 승인합니다. 제안 완료를 개발 완료로 기록하지 마세요.',
  ].join('\n')
}
