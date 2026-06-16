-- 112: SAS-09 Tenant Domains. Кастомные домены тенантов: верификация через DNS
-- (TXT/CNAME — реальная проверка node:dns, без ключей), SSL-сертификаты (state machine,
-- фактический выпуск ACME активируется инфраструктурой), DNS-записи (инструкции + проверка).
-- Платформенные таблицы (как saas_plans — БЕЗ per-tenant RLS): суперадмин видит всех,
-- tenant-facing фильтрует по tenant_id явно. id SERIAL (как мигр.110/111).
BEGIN;

CREATE TABLE IF NOT EXISTS custom_domains (
  id                  SERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL,
  domain              TEXT UNIQUE NOT NULL,
  is_primary          BOOLEAN NOT NULL DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT 'pending_verification', -- pending_verification|dns_verified|ssl_issuing|active|inactive|failed|expired
  verification_method TEXT NOT NULL DEFAULT 'cname',                -- cname|txt
  verification_token  TEXT NOT NULL,
  verified_at         TIMESTAMPTZ,
  activated_at        TIMESTAMPTZ,
  redirect_www        BOOLEAN NOT NULL DEFAULT TRUE,
  force_https         BOOLEAN NOT NULL DEFAULT TRUE,
  custom_headers      JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_check_at       TIMESTAMPTZ,
  last_check_status   TEXT,                                         -- healthy|degraded|down|unknown
  uptime_30d          NUMERIC(5,2),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cd_tenant ON custom_domains(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cd_domain ON custom_domains(domain);
CREATE INDEX IF NOT EXISTS idx_cd_status ON custom_domains(status);

CREATE TABLE IF NOT EXISTS ssl_certificates (
  id                 SERIAL PRIMARY KEY,
  domain_id          INTEGER NOT NULL REFERENCES custom_domains(id) ON DELETE CASCADE,
  issuer             TEXT NOT NULL DEFAULT 'letsencrypt',           -- letsencrypt|custom|platform_wildcard
  status             TEXT NOT NULL DEFAULT 'pending',               -- pending|issuing|active|expiring_soon|expired|failed
  issued_at          TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ,
  auto_renew         BOOLEAN NOT NULL DEFAULT TRUE,
  last_renewal_at    TIMESTAMPTZ,
  next_renewal_at    TIMESTAMPTZ,
  renewal_attempts   SMALLINT NOT NULL DEFAULT 0,
  cert_pem           TEXT,
  chain_pem          TEXT,
  private_key_ref    TEXT,                                          -- ссылка на vault, НЕ сам ключ
  fingerprint_sha256 TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ssl_domain ON ssl_certificates(domain_id);
CREATE INDEX IF NOT EXISTS idx_ssl_expires ON ssl_certificates(expires_at) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_ssl_renew ON ssl_certificates(next_renewal_at) WHERE auto_renew=TRUE;

CREATE TABLE IF NOT EXISTS dns_records (
  id            SERIAL PRIMARY KEY,
  domain_id     INTEGER NOT NULL REFERENCES custom_domains(id) ON DELETE CASCADE,
  record_type   TEXT NOT NULL,                                      -- CNAME|TXT|A|AAAA
  name          TEXT NOT NULL,
  value         TEXT NOT NULL,
  purpose       TEXT NOT NULL,                                      -- verification|routing|spf|dkim
  is_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at   TIMESTAMPTZ,
  last_check_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dns_domain ON dns_records(domain_id);
CREATE INDEX IF NOT EXISTS idx_dns_verified ON dns_records(is_verified) WHERE is_verified=FALSE;

GRANT SELECT, INSERT, UPDATE, DELETE ON custom_domains, ssl_certificates, dns_records TO app_tenant;
GRANT USAGE, SELECT ON SEQUENCE custom_domains_id_seq, ssl_certificates_id_seq, dns_records_id_seq TO app_tenant;

COMMIT;
