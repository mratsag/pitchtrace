-- PitchTrace — F2 active-audit race protection
SET search_path = pitchtrace, public;

-- Older installations may contain active duplicates created by concurrent API
-- calls before the database invariant existed. Keep the oldest active audit and
-- close later duplicates explicitly so index creation cannot fail.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY company_id ORDER BY created_at, id) AS n
  FROM audits WHERE status IN ('queued','running')
), closed AS (
  UPDATE audits a SET status='failed', finished_at=now(),
    error_code='DUPLICATE_ACTIVE_AUDIT', error_message='closed during F2 migration'
  FROM ranked r WHERE a.id=r.id AND r.n>1 RETURNING a.id
)
UPDATE audit_jobs j SET status='failed', locked_at=NULL, locked_by=NULL,
  last_error='duplicate active audit closed during F2 migration'
WHERE j.audit_id IN (SELECT id FROM closed);

CREATE UNIQUE INDEX IF NOT EXISTS audits_one_active_per_company_idx
  ON audits(company_id) WHERE status IN ('queued','running');
