import { IMPORT_LIMITS } from './codes.js';

export class MultipartCsvError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); }
}

/** Bounded, single-file multipart reader. No temporary files are created. */
export function extractCsvFile(contentType: string | undefined, body: Buffer): Buffer {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 200) throw new MultipartCsvError('INVALID_MULTIPART', 'multipart boundary is missing or invalid');
  const marker = `--${boundary}`;
  const raw = body.toString('latin1');
  const segments = raw.split(marker);
  if (segments.length < 3 || !segments.at(-1)?.trim().startsWith('--')) throw new MultipartCsvError('INVALID_MULTIPART', 'multipart body is incomplete');
  let csv: Buffer | null = null;
  for (const original of segments.slice(1, -1)) {
    let segment = original;
    if (segment.startsWith('\r\n')) segment = segment.slice(2);
    const headerEnd = segment.indexOf('\r\n\r\n');
    if (headerEnd < 0 || headerEnd > 8_192) throw new MultipartCsvError('INVALID_MULTIPART', 'multipart part headers are invalid');
    const headers = segment.slice(0, headerEnd);
    const disposition = /^content-disposition:\s*form-data;([^\r\n]+)$/im.exec(headers)?.[1] ?? '';
    const name = /(?:^|;)\s*name="([^"]+)"/i.exec(disposition)?.[1];
    const filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1];
    if (name !== 'file' || filename === undefined || csv !== null) throw new MultipartCsvError('UNEXPECTED_MULTIPART_PART', 'exactly one file field named "file" is required');
    const type = /^content-type:\s*([^\r\n;]+)/im.exec(headers)?.[1]?.toLowerCase();
    if (type && !['text/csv','application/vnd.ms-excel','application/octet-stream'].includes(type)) throw new MultipartCsvError('UNSUPPORTED_MEDIA_TYPE', 'file must be CSV', 415);
    let content = segment.slice(headerEnd + 4);
    if (content.endsWith('\r\n')) content = content.slice(0, -2);
    csv = Buffer.from(content, 'latin1');
  }
  if (!csv) throw new MultipartCsvError('CSV_FILE_REQUIRED', 'CSV file is required');
  if (csv.byteLength > IMPORT_LIMITS.maxFileBytes) throw new MultipartCsvError('CSV_FILE_TOO_LARGE', `CSV exceeds ${IMPORT_LIMITS.maxFileBytes} bytes`, 413);
  return csv;
}
