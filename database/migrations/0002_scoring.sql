-- PitchTrace — 0002_scoring
-- Fırsat puanlama (F6).

SET search_path = pitchtrace, public;

-- Kampanyanın "bu problemi biz çözebiliyoruz" ağırlıkları:
-- { "MOB_NO_VIEWPORT": 8, "CONV_NO_CONTACT_FORM": 6, ... }
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS service_fit jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS scores (
  audit_id     uuid PRIMARY KEY REFERENCES audits(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  total        int  NOT NULL CHECK (total BETWEEN 0 AND 100),
  -- Bileşenlerin toplamı her zaman total'a eşittir (no_contact_penalty dahil).
  breakdown    jsonb NOT NULL,
  -- Puanın nasıl oluştuğunu insana açıklayan döküm.
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  rule_version text NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scores_company_idx ON scores(company_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS scores_total_idx ON scores(total DESC);
