import path from 'node:path'

export function sameExecutionWorkspace(left, right) {
  const normalize = (value) => {
    const text = String(value ?? '').trim()
    if (!text) return ''
    return (process.platform === 'win32' || /^[a-z]:[\\/]|^\\\\/i.test(text) ? path.win32.normalize(text).toLowerCase() : path.normalize(text)).replaceAll('\\', '/').replace(/\/+$/, '')
  }
  return Boolean(left && right) && normalize(left) === normalize(right)
}

// 문서 근거가 하나일 때만 기본값을 정한다. pool이 있다는 이유만으로
// MnP 유지보수 문서까지 같은 프로젝트에 귀속시키지 않는다.
export function doorayExecutionWorkspace(registry, mainMachine, candidates = [], serverDirectory = '') {
  const unique = (values) => values.filter((value, index) => value && !values.slice(0, index).some((previous) => sameExecutionWorkspace(previous, value)))
  const documentWorkspaces = unique(candidates.filter((value) => String(value ?? '').trim()
    && !/(^|[\\/])_dooray-response-workspaces([\\/]|$)/i.test(value)).map((value) => {
    const pooled = mainMachine && registry?.workspaces?.some((entry) => sameExecutionWorkspace(entry.root, value))
    return pooled && registry.integration?.root ? registry.integration.root : value
  }))
  return { defaultWorkspace: documentWorkspaces.length === 1 ? documentWorkspaces[0] : '',
    workspaceChoices: unique([...documentWorkspaces, ...(mainMachine ? [registry?.integration?.root, serverDirectory] : [])]),
    workspaceNeedsSelection: documentWorkspaces.length !== 1 }
}

export function assertDoorayExecutionWorkspace(workspace) {
  if (!String(workspace ?? '').trim() || (!path.isAbsolute(workspace) && !path.win32.isAbsolute(workspace))
    || /(^|[\\/])_dooray-response-workspaces([\\/]|$)/i.test(String(workspace))) {
    throw Object.assign(new Error('제안 보관 폴더가 아닌 실제 업무 작업공간의 절대 경로를 지정해 주세요.'), { status: 409 })
  }
}
