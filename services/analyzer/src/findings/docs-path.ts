import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** dist/src/findings → repo kökü/docs/finding-codes.md */
export function findingCodesDocPath(): string {
  const fromEnv = process.env['FINDING_CODES_DOC'];
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(here, '../../../../../docs/finding-codes.md');
}
