import assert from 'node:assert/strict'
import test from 'node:test'
import { copiedImagePlacementOverrides } from '../src/utils/imageClipboard.mjs'

test('이미지 하나는 붙여넣기 지점을 중심으로 기존 크기를 유지한다', () => {
  assert.deepEqual(copiedImagePlacementOverrides([{
    position: { x: 120, y: 240 },
    image: { displayWidth: 320, displayHeight: 180 },
    description: '대표 이미지',
  }]), [{
    displayWidth: 320,
    displayHeight: 180,
    description: '대표 이미지',
    offsetX: 0,
    offsetY: 0,
  }])
})

test('여러 이미지는 묶음 중심을 기준으로 크기와 상대 배치를 유지한다', () => {
  assert.deepEqual(copiedImagePlacementOverrides([{
    position: { x: 100, y: 200 },
    image: { displayWidth: 200, displayHeight: 100 },
    description: '왼쪽',
  }, {
    position: { x: 400, y: 500 },
    image: { displayWidth: 100, displayHeight: 200 },
    description: '오른쪽',
  }]), [{
    displayWidth: 200,
    displayHeight: 100,
    description: '왼쪽',
    offsetX: -100,
    offsetY: -200,
  }, {
    displayWidth: 100,
    displayHeight: 200,
    description: '오른쪽',
    offsetX: 150,
    offsetY: 150,
  }])
})

test('복사한 이미지가 없으면 배치 정보도 만들지 않는다', () => {
  assert.deepEqual(copiedImagePlacementOverrides([]), [])
})
