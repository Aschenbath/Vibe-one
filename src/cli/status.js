export function exitCodeForStatus(status) {
  return status === 'success' || status === 'planned' ? 0 : 2;
}
