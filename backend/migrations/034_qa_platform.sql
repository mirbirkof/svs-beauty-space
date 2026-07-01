-- QA-платформа: служебные таблицы (не клиентские данные, вне tenant-изоляции).
-- Мост между QA-loop (DigitalOcean) и панелью на Render — общая Neon-база.

CREATE TABLE IF NOT EXISTS qa_bugs (
  signature       text PRIMARY KEY,
  id              text,
  severity        text,
  module          text,
  role            text,
  title           text,
  scenario        text,
  expected        text,
  actual          text,
  cause           text,
  fix             text,
  steps           jsonb DEFAULT '[]'::jsonb,
  status          text DEFAULT 'open',       -- open|reopened|closed|manual|ignored
  needs_manual    boolean DEFAULT false,
  manual_reason   text,
  seen_count      integer DEFAULT 1,
  first_seen      timestamptz,
  last_seen       timestamptz,
  fix_requested   boolean DEFAULT false,
  fix_requested_at timestamptz,
  ignored_at      timestamptz,
  closed_at       timestamptz,
  updated_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qa_bugs_status ON qa_bugs(status);

-- Снимок статуса платформы (одна строка id=1): агрегаты + агенты.
CREATE TABLE IF NOT EXISTS qa_status (
  id       integer PRIMARY KEY DEFAULT 1,
  cycle    integer,
  mode     text,
  checks   integer,
  modules  integer,
  bugs     jsonb,
  agents   jsonb,
  at       timestamptz DEFAULT now()
);

-- Управление из панели (одна строка id=1): пауза и т.п.
CREATE TABLE IF NOT EXISTS qa_control (
  id         integer PRIMARY KEY DEFAULT 1,
  paused     boolean DEFAULT false,
  updated_at timestamptz DEFAULT now()
);
INSERT INTO qa_control (id, paused) VALUES (1, false) ON CONFLICT (id) DO NOTHING;
