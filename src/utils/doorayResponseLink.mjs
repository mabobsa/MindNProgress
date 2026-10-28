export function doorayResponseIdFromSearch(search) {
  const id = new URLSearchParams(search).get('doorayResponseId') ?? ''
  return /^[a-zA-Z0-9_-]{1,160}$/.test(id) ? id : ''
}
