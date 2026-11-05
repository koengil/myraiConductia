/** Strip control characters that could break or inject response headers. */
export function sanitizeDownloadFilename(name: string): string {
  const stripped = name.replace(/[\0-\x1f\x7f\r\n"\\]/g, '').trim();
  return stripped || 'download';
}

export function contentDispositionAttachment(filename: string): string {
  return `attachment; filename="${sanitizeDownloadFilename(filename)}"`;
}
