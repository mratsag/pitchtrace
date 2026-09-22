-- PitchTrace — 0001_init
-- Dikey dilim için gereken minimum şema.
-- contacts, drafts, claims, approvals, outreach_log, suppression_list ve
-- scores tabloları F1'de eklenecektir; burada bilerek yoktur.

CREATE SCHEMA IF NOT EXISTS pitchtrace;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

SET search_path = pitchtrace, public;

CREATE TABLE IF NOT EXISTS campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  sector        text NOT NULL,
  city          text NOT NULL,
  country       text NOT NULL DEFAULT 'TR',
  language      text NOT NULL DEFAULT 'tr' CHECK (language IN ('tr','en')),
  max_companies int  NOT NULL DEFAULT 50 CHECK (max_companies BETWEEN 1 AND 50),
  page_limit    int  NOT NULL DEFAULT 5  CHECK (page_limit BETWEEN 1 AND 5),
  min_score     int  NOT NULL DEFAULT 70 CHECK (min_score BETWEEN 0 AND 100),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name              text NOT NULL,
  -- Kullanıcının verdiği ham değer. Redirect sonuçları bunu ASLA ezmez.
  submitted_url     text NOT NULL,
  -- lowercase, www yok, punycode, path/query yok
  normalized_domain citext NOT NULL,
  -- ilk başarılı audit'in final URL'i
  resolved_url      text,
  source            text NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('csv','manual','api')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companies_campaign_domain_unique UNIQUE (campaign_id, normalized_domain)
);

CREATE INDEX IF NOT EXISTS companies_campaign_idx ON companies(campaign_id);

CREATE TABLE IF NOT EXISTS audits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','completed','failed')),
  page_limit        int  NOT NULL DEFAULT 1 CHECK (page_limit BETWEEN 1 AND 5),
  entry_url         text NOT NULL,
  final_url         text,
  robots_allowed    boolean,
  pages_planned     int NOT NULL DEFAULT 0,
  pages_fetched     int NOT NULL DEFAULT 0,
  bytes_transferred bigint NOT NULL DEFAULT 0,
  analyzer_version  text NOT NULL,
  started_at        timestamptz,
  finished_at       timestamptz,
  error_code        text,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audits_company_idx ON audits(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_pages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id    uuid NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  url         text NOT NULL,
  role        text NOT NULL CHECK (role IN ('home','contact','about','sitemap_pick')),
  http_status int,
  final_url   text,
  load_ms     int,
  html_bytes  int,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  error       text,
  blocked_resources jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (audit_id, url)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id   uuid NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('screenshot','export')),
  -- ARTIFACT_ROOT'a göre relative; mutlak yol yazmak yasaktır
  rel_path   text NOT NULL,
  mime       text NOT NULL,
  bytes      int  NOT NULL,
  sha256     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS artifacts_audit_idx ON artifacts(audit_id);

CREATE TABLE IF NOT EXISTS findings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id     uuid NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code         text NOT NULL,
  category     text NOT NULL
               CHECK (category IN ('MOBILE','TECH','PERF','SEO','CONV','CONTACT','INF')),
  severity     text NOT NULL CHECK (severity IN ('low','medium','high')),
  confidence   text NOT NULL CHECK (confidence IN ('observed','inferred','manual')),
  url          text,
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  metric_name  text,
  metric_value numeric,
  metric_unit  text,
  artifact_id  uuid REFERENCES artifacts(id) ON DELETE SET NULL,
  observed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (audit_id, code, url)
);

CREATE INDEX IF NOT EXISTS findings_audit_idx ON findings(audit_id);

CREATE TABLE IF NOT EXISTS audit_jobs (
  id           bigserial PRIMARY KEY,
  audit_id     uuid NOT NULL UNIQUE REFERENCES audits(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','completed','failed')),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 2,
  run_after    timestamptz NOT NULL DEFAULT now(),
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_jobs_pickup_idx
  ON audit_jobs(status, run_after, created_at)
  WHERE status = 'queued';
