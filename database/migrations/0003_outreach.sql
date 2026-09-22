-- PitchTrace — F1 outreach data model
SET search_path = pitchtrace, public;

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email citext NOT NULL,
  name text,
  role text,
  source_url text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, email)
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_one_primary_idx
  ON contacts(company_id) WHERE is_primary;

CREATE TABLE IF NOT EXISTS email_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  audit_id uuid NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  language text NOT NULL CHECK (language IN ('tr','en')),
  subject text NOT NULL,
  greeting text NOT NULL DEFAULT '',
  closing text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN
    ('pending_review','rejected_by_validator','approved','rejected_by_human')),
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_drafts_company_idx ON email_drafts(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS draft_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES email_drafts(id) ON DELETE CASCADE,
  position int NOT NULL CHECK (position >= 0),
  text text NOT NULL,
  claim_type text NOT NULL CHECK (claim_type IN ('assertion','question','neutral')),
  confidence text NOT NULL CHECK (confidence IN ('observed','inferred')),
  UNIQUE (draft_id, position)
);

CREATE TABLE IF NOT EXISTS draft_claim_findings (
  claim_id uuid NOT NULL REFERENCES draft_claims(id) ON DELETE CASCADE,
  finding_id uuid NOT NULL REFERENCES findings(id) ON DELETE RESTRICT,
  PRIMARY KEY (claim_id, finding_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES email_drafts(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_by text NOT NULL,
  note text,
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approvals_draft_idx ON approvals(draft_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS outreach_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES email_drafts(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'manual_email',
  status text NOT NULL CHECK (status IN ('exported','sent','replied','no_reply','bounced','opted_out')),
  marked_by text NOT NULL,
  note text,
  marked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppression_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('email','domain')),
  value citext NOT NULL,
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, value)
);
