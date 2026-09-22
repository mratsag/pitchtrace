-- Deliberately fictional and reserved: safe for demos and CI.
SET search_path = pitchtrace, public;
INSERT INTO campaigns (id, name, sector, city, language)
VALUES ('00000000-0000-4000-8000-000000000101', 'Kurgusal Pilot', 'demo', 'Örnekşehir', 'tr')
ON CONFLICT DO NOTHING;
INSERT INTO companies (id, campaign_id, name, submitted_url, normalized_domain, source)
VALUES ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000101',
        'Örnek İşletme', 'https://ornek-isletme.invalid', 'ornek-isletme.invalid', 'manual')
ON CONFLICT DO NOTHING;
INSERT INTO contacts (company_id, email, name, role, is_primary)
VALUES ('00000000-0000-4000-8000-000000000102', 'iletisim@ornek-isletme.invalid',
        'Örnek Kişi', 'demo', true)
ON CONFLICT DO NOTHING;
