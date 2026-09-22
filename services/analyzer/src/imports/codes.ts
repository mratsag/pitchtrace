export const IMPORT_CODES = {
  duplicateInFile: 'DUPLICATE_IN_FILE', duplicateExisting: 'DUPLICATE_EXISTING',
  missingRequiredValue: 'MISSING_REQUIRED_VALUE', invalidUrl: 'INVALID_URL', unsafeUrl: 'UNSAFE_URL',
  invalidEmail: 'INVALID_EMAIL', formulaCell: 'FORMULA_CELL', fieldTooLong: 'FIELD_TOO_LONG',
  columnCountMismatch: 'COLUMN_COUNT_MISMATCH', emailSuppressed: 'EMAIL_SUPPRESSED',
  domainSuppressed: 'DOMAIN_SUPPRESSED', campaignLimit: 'CAMPAIGN_LIMIT_REACHED',
  rowWriteFailed: 'ROW_WRITE_FAILED',
} as const;

export type ImportStatus = 'imported' | 'duplicate' | 'suppressed' | 'invalid';
export interface ImportRowResult {
  row: number; status: ImportStatus; company_id: string | null; code: string | null; message: string | null;
}

export const IMPORT_LIMITS = {
  maxFileBytes: 128 * 1024, maxRows: 50, maxFieldChars: 2_000,
  maxCompanyNameChars: 200, maxWebsiteChars: 2_000, maxContactNameChars: 200,
  maxEmailChars: 320,
} as const;
