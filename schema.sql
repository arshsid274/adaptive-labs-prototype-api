
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT DEFAULT 'America/New_York',
  dograh_base_url TEXT,
  dograh_api_key TEXT,
  telephony_provider TEXT NOT NULL DEFAULT 'twilio',
  twilio_account_sid TEXT,
  twilio_auth_token TEXT,
  twilio_from_number TEXT,
  telnyx_api_key TEXT,
  telnyx_from_number TEXT,
  telnyx_connection_id TEXT,
  telnyx_messaging_profile_id TEXT,
  openai_api_key TEXT,
  openai_model TEXT DEFAULT 'gpt-4o-mini',
  openai_realtime_model TEXT DEFAULT 'gpt-4o-realtime-preview',
  stt_provider TEXT NOT NULL DEFAULT 'openai',
  tts_provider TEXT NOT NULL DEFAULT 'openai',
  simulation_mode INTEGER NOT NULL DEFAULT 1,
  quiet_hours_start TEXT DEFAULT '21:00',
  quiet_hours_end TEXT DEFAULT '08:00',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  company TEXT,
  source TEXT DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'new',
  score INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  tags TEXT DEFAULT '[]',
  notes TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  consent_sms INTEGER NOT NULL DEFAULT 1,
  last_contacted_at TEXT,
  custom TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_org ON leads(org_id, status);

CREATE TABLE IF NOT EXISTS voice_agents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'lead_qualifier',
  description TEXT,
  language TEXT NOT NULL DEFAULT 'en-US',
  voice TEXT NOT NULL DEFAULT 'alloy',
  persona TEXT,
  goal TEXT,
  greeting TEXT,
  system_prompt TEXT,
  max_duration_seconds INTEGER NOT NULL DEFAULT 300,
  transfer_number TEXT,
  from_number TEXT,
  telephony_provider TEXT,
  llm_provider TEXT NOT NULL DEFAULT 'openai',
  llm_model TEXT,
  openai_api_key TEXT,
  stt_provider TEXT,
  tts_provider TEXT,
  temperature REAL NOT NULL DEFAULT 0.4,
  dograh_workflow_id TEXT,
  dograh_published INTEGER NOT NULL DEFAULT 0,
  extraction TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES voice_agents(id) ON DELETE SET NULL,
  automation_id TEXT,
  direction TEXT NOT NULL DEFAULT 'outbound',
  provider TEXT NOT NULL DEFAULT 'twilio',
  provider_call_sid TEXT,
  dograh_run_id TEXT,
  to_number TEXT,
  from_number TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  disposition TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  recording_url TEXT,
  transcript TEXT,
  summary TEXT,
  sentiment TEXT,
  gathered TEXT DEFAULT '{}',
  cost REAL NOT NULL DEFAULT 0,
  simulated INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_org ON calls(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  party_size INTEGER,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  automation_id TEXT,
  channel TEXT NOT NULL DEFAULT 'sms',
  direction TEXT NOT NULL DEFAULT 'outbound',
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  provider_sid TEXT,
  error TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'sms',
  platform TEXT NOT NULL DEFAULT 'google',
  status TEXT NOT NULL DEFAULT 'sent',
  rating INTEGER,
  feedback TEXT,
  requested_at TEXT NOT NULL,
  responded_at TEXT
);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  agent_id TEXT REFERENCES voice_agents(id) ON DELETE SET NULL,
  trigger TEXT NOT NULL DEFAULT '{"kind":"manual"}',
  conditions TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  last_run_at TEXT,
  next_run_at TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  trigger_event TEXT,
  entity_type TEXT,
  entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  steps TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_org ON automation_runs(org_id, started_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  automation_id TEXT,
  run_id TEXT,
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  run_after TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_org ON events(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS error_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'error',
  message TEXT NOT NULL,
  context TEXT DEFAULT '{}',
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_sync_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'outbound',
  status TEXT NOT NULL,
  request TEXT,
  response TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  period TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  meta TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- Mobile sign-in: one row per refresh token. Only a SHA-256 hash is stored.
-- Rotated on every refresh; reusing an old token revokes its whole family.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  client TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_family ON sessions(family_id);

-- AI provider keys (OpenAI, Anthropic, ElevenLabs, ...), AES-256-GCM encrypted.
CREATE TABLE IF NOT EXISTS provider_keys (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  api_key_enc TEXT,
  last4 TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, provider)
);

-- Other CRMs whose call results the app shows (Buddha Avenue bridge, ...).
CREATE TABLE IF NOT EXISTS crm_connectors (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT,
  secret_enc TEXT,
  bookings_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, kind)
);
