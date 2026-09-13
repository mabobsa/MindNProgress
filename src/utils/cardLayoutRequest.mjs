import { validateCardLayoutTarget } from './cardLayout.mjs'

export function buildCardLayoutRequestPrompt(request) {
  if (!/^layout-request-[a-zA-Z0-9-]+$/.test(request?.id ?? '')) throw new Error('배치 요청 ID가 필요합니다.')
  const target = validateCardLayoutTarget(request.target)
  return [
    '사용자가 현재 문서의 AI 배치 제안을 요청했습니다. 허용 범위는 원본 조회와 이 요청에 배치안을 제출하는 것입니다.',
    `요청 ID: ${request.id}`,
    `목표 캔버스 비율은 ${target.ratio}입니다. 휴대폰에서 요청했더라도 목표 비율을 바꾸지 않습니다. 해상도 크기 제한은 없으며 같은 내용·실측 크기·순서·비율이면 FHD·QHD에서도 같은 배치 좌표를 계산합니다. 화면에 맞춘 확대·축소는 배치 계산과 별개입니다.`,
    'mindnprogress_get_card_layout_request({requestId})로 서버의 사용자 승인·원본 스냅샷·실제 크기·revision·stale을 확인하세요. stale이면 원본을 수정하거나 다른 요청을 만들지 말고 사용자에게 새 요청이 필요함을 알리세요.',
    'snapshot.renderMap의 모든 카드·계층선·지식선과 measurements의 실제 크기, 원래 화면 순서를 분석하세요. 카드는 역할과 표시 유형에 따라 묶음·실행 업무·일반 지식·Ref·Dooray·이미지로 구분합니다.',
    '계층·하위 트리·모든 카드를 보존하며 같은 부모 안에서 같은 종류를 모으세요. 독립 자료는 연결된 가지 가까이, 여러 가지가 공유하는 자료는 주요 지식 연결을 우선 고려해 한 번만, 연결 없는 카드는 별도 영역으로 배치합니다. 여러 트리는 합치지 않습니다.',
    '종류별 묶음과 지식선 길이·교차 감소를 함께 고려하여 모든 카드 ID가 정확히 한 번 있는 order 배열과 사람이 이해할 수 있는 reason을 작성하세요. 동일 조건이면 기존 상대 순서를 유지합니다.',
    'mindnprogress_submit_card_layout_proposal({requestId,baseRevision,plan:{order,reason}})로 제출하세요. 좌표와 크기는 넣지 않습니다. 제품이 실측 크기로 좌표·32px 여백·우측 확장·대표 루트 위치를 계산하고 사용자가 실제 미리보기를 승인해야 적용됩니다.',
    '제품은 하위 트리를 보존한 여러 행·열 배치 후보를 생성하며 사용자가 화면 균형형과 다른 형태를 비교할 수 있습니다. 화면에 맞춘다는 이유로 카드·내용을 숨기거나 크기를 바꾸지 않습니다. 실제 미리보기 전 모든 내용이 읽힌다고 보장하지 마세요.',
    '원본 문서·카드·관계·댓글·상태·코드 변경, 추가 AI 위임, 자동 적용은 허용되지 않습니다. 제출 결과와 배치 이유를 사용자에게 설명하세요.',
  ].join('\n')
}
