/**
 * Lightweight local API for the Adaptive Labs native app. It deliberately avoids a Next
 * frontend build, so a phone on the same LAN can use the CRM data while the
 * full web server is not running. The agent builder routes (create, edit,
 * publish, AI drafts, voice previews) mirror the web app's, since the two
 * servers don't share secrets.
 */
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import pg from "pg";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";

const port = Number(process.env.PORT || 3001);
const dataDir = process.env.CRM_DATA_DIR || path.join(process.cwd(), ".data");
if (process.env.NODE_ENV === "production" && (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32 || !process.env.SECRETS_KEY)) throw new Error("Production AUTH_SECRET (32+ chars) and SECRETS_KEY are required");
mkdirSync(dataDir, { recursive: true });
const databasePath = path.join(dataDir, "crm.sqlite");
const databaseUrl = process.env.DATABASE_URL;
if (process.env.NODE_ENV === "production" && !databaseUrl) throw new Error("DATABASE_URL is required to keep prototype data across restarts");
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 15000, query_timeout: 30000 }) : null;
if (pool) {
  await pool.query("CREATE TABLE IF NOT EXISTS prototype_state (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const stored = await pool.query("SELECT snapshot FROM prototype_state WHERE id = 1");
  if (stored.rows.length) {
    writeFileSync(databasePath, stored.rows[0].snapshot, { mode: 0o600 });
    console.log("[persistence] restored database snapshot");
  } else console.log("[persistence] initializing a new database");
}
const db = new DatabaseSync(databasePath);
db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
for (const [table, column, ddl] of JSON.parse(readFileSync(new URL("./migrations.json", import.meta.url), "utf8"))) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
if (!db.prepare("SELECT id FROM users LIMIT 1").get()) {
  const email = process.env.BOOTSTRAP_OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (!email || !password || password.length < 12) throw new Error("Set BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD (at least 12 characters) to initialize the prototype");
  const orgId = `org_${randomBytes(10).toString("hex")}`;
  const userId = `usr_${randomBytes(10).toString("hex")}`;
  const now = new Date().toISOString();
  const hash = await bcrypt.hash(password, 12);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO organizations (id,name,timezone,simulation_mode,created_at) VALUES (?,?,?,?,?)").run(orgId, "Adaptive Labs Prototype", "Asia/Kolkata", 1, now);
    db.prepare("INSERT INTO users (id,org_id,email,name,password_hash,role,active,created_at) VALUES (?,?,?,?,?,?,?,?)").run(userId,orgId,email,"Owner",hash,"owner",1,now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

// The public demo account is isolated from the private owner workspace.
const DEMO_ORG_ID = "org_public_demo";
const DEMO_EMAIL = "owner@demo.test";
const existingDemo = db.prepare("SELECT org_id FROM users WHERE email = ?").get(DEMO_EMAIL);
if (existingDemo && existingDemo.org_id !== DEMO_ORG_ID) throw new Error("Demo email already belongs to another workspace");
if (!existingDemo) {
  const now = new Date().toISOString();
  const demoHash = await bcrypt.hash("demo1234", 12);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT OR IGNORE INTO organizations (id,name,timezone,simulation_mode,created_at) VALUES (?,?,?,?,?)").run(DEMO_ORG_ID,"Adaptive Labs Demo","Asia/Kolkata",1,now);
    db.prepare("INSERT INTO users (id,org_id,email,name,password_hash,role,active,created_at) VALUES (?,?,?,?,?,?,?,?)").run("usr_public_demo",DEMO_ORG_ID,DEMO_EMAIL,"Demo Owner",demoHash,"owner",1,now);
    db.prepare("INSERT INTO voice_agents (id,org_id,name,kind,description,greeting,system_prompt,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("va_public_demo",DEMO_ORG_ID,"Demo Assistant","lead_qualifier","A sample assistant for exploring the app.","Hello! How can I help you today?","You are a friendly demo assistant.","draft","usr_public_demo",now,now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

// Older local demo databases predate mobile refresh tokens. This additive
// migration is the same storage shape the main CRM server expects.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    family_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    client TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_family ON sessions(family_id);
  CREATE TABLE IF NOT EXISTS provider_keys (
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    api_key_enc TEXT,
    last4 TEXT,
    updated_by TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, provider)
  );
`);
// Voice model columns the web app added later; creating agents writes them.
for (const column of ["tts_model", "stt_model"]) {
  if (!db.prepare("PRAGMA table_info(voice_agents)").all().some((c) => c.name === column)) {
    db.exec(`ALTER TABLE voice_agents ADD COLUMN ${column} TEXT`);
  }
}
// Serialize snapshots so a successful write is acknowledged only after the
// fresh SQLite image has been committed to the external Postgres database.
let persistedChanges = -1;
let snapshotQueue = Promise.resolve();
function persistDatabase() {
  if (!pool) return Promise.resolve();
  const pending = snapshotQueue.catch(() => {}).then(async () => {
    const before = Number(db.prepare("SELECT total_changes() AS count").get().count);
    if (before === persistedChanges) return;
    const temp = path.join(dataDir, `snapshot-${randomBytes(8).toString("hex")}.sqlite`);
    try {
      await backup(db, temp);
      const bytes = readFileSync(temp);
      await pool.query("INSERT INTO prototype_state (id, snapshot, updated_at) VALUES (1, $1, NOW()) ON CONFLICT (id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = NOW()", [bytes]);
      persistedChanges = before;
    } finally { try { unlinkSync(temp); } catch {} }
  });
  snapshotQueue = pending;
  return pending;
}
await persistDatabase();
const secret = new TextEncoder().encode(process.env.AUTH_SECRET || "dev-only-insecure-secret-change-me-32bytes");
const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
};
const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);
const id = (prefix) => `${prefix}_${randomBytes(10).toString("hex")}`;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const parse = (value, fallback = []) => { try { return typeof value === "string" ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } };

async function accessToken(user) {
  return new SignJWT({ ...user, typ: "access" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(secret);
}

async function tokens(user, family = id("fam")) {
  const refresh = randomBytes(32).toString("base64url");
  run("INSERT INTO sessions (id,user_id,org_id,family_id,token_hash,client,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
    id("ses"), user.id, user.org_id, family, sha256(refresh), "ios", new Date(Date.now() + 30 * 86400e3).toISOString(), new Date().toISOString());
  return { access_token: await accessToken(user), refresh_token: refresh, token_type: "Bearer", expires_in: 3600 };
}

async function current(req) {
  const value = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!value) return null;
  try {
    const { payload } = await jwtVerify(value, secret);
    if (payload.typ !== "access" || !payload.id) return null;
    const row = one("SELECT id,org_id,email,name,role,active FROM users WHERE id=?", String(payload.id));
    return row?.active ? { id: row.id, org_id: row.org_id, email: row.email, name: row.name, role: row.role } : null;
  } catch { return null; }
}

function agent(row) {
  if (!row) return row;
  // The per-agent key leaves masked, like the web app, so editors never echo the stored value back.
  const key = decryptProviderKey(row.openai_api_key);
  return { ...row, extraction: parse(row.extraction), call_count: Number(row.call_count || 0), openai_api_key: key ? `****${key.slice(-4)}` : null };
}

function lead(row) {
  if (!row) return row;
  return { ...row, tags: parse(row.tags), custom: parse(row.custom, {}) };
}

function call(row) {
  if (!row) return row;
  return { ...row, gathered: parse(row.gathered, {}) };
}

function dashboard(user) {
  const org = one("SELECT * FROM organizations WHERE id=?", user.org_id);
  const since = new Date(Date.now() - 7 * 86400e3).toISOString();
  const day = new Date(Date.now() - 86400e3).toISOString();
  const calls = one("SELECT COUNT(*) total, SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) last24, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed, SUM(CASE WHEN disposition='booked' THEN 1 ELSE 0 END) booked, COALESCE(SUM(duration_seconds),0) secs, COALESCE(SUM(cost),0) cost FROM calls WHERE org_id=?", day, user.org_id) || {};
  const leads = one("SELECT COUNT(*) total, SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) last7, SUM(CASE WHEN status='new' THEN 1 ELSE 0 END) new, SUM(CASE WHEN status='qualified' THEN 1 ELSE 0 END) qualified, SUM(CASE WHEN status='booked' THEN 1 ELSE 0 END) booked, SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) won FROM leads WHERE org_id=?", since, user.org_id) || {};
  const runs = one("SELECT COUNT(*) total, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed, SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) skipped FROM automation_runs WHERE org_id=?", user.org_id) || {};
  const automations = one("SELECT COUNT(*) total, SUM(enabled) enabled FROM automations WHERE org_id=?", user.org_id) || {};
  const recentCalls = all("SELECT c.*,l.name lead_name,a.name agent_name FROM calls c LEFT JOIN leads l ON l.id=c.lead_id LEFT JOIN voice_agents a ON a.id=c.agent_id WHERE c.org_id=? ORDER BY c.created_at DESC LIMIT 10", user.org_id);
  const recentRuns = all("SELECT r.*,a.name automation_name FROM automation_runs r LEFT JOIN automations a ON a.id=r.automation_id WHERE r.org_id=? ORDER BY r.started_at DESC LIMIT 8", user.org_id).map((r) => ({ ...r, steps: parse(r.steps, []) }));
  return {
    org: { id: org.id, name: org.name, timezone: org.timezone, simulation: Boolean(org.simulation_mode) },
    providers: { dograh: Boolean(org.dograh_api_key), twilio: Boolean(org.twilio_account_sid), telnyx: Boolean(org.telnyx_api_key), openai: Boolean(org.openai_api_key), active_carrier: org.telephony_provider || "twilio" },
    stats: { calls, leads, automations, runs },
    by_type: all("SELECT type,COUNT(*) n,COALESCE(SUM(enabled),0) enabled FROM automations WHERE org_id=? GROUP BY type", user.org_id),
    dispositions: all("SELECT COALESCE(disposition,'unknown') disposition,COUNT(*) n FROM calls WHERE org_id=? GROUP BY disposition", user.org_id),
    recent_runs: recentRuns, recent_calls: recentCalls,
    pending_jobs: all("SELECT j.*,a.name automation_name FROM jobs j LEFT JOIN automations a ON a.id=j.automation_id WHERE j.org_id=? AND j.status='pending' ORDER BY j.run_after LIMIT 10", user.org_id),
    errors: all("SELECT * FROM error_log WHERE org_id=? AND resolved=0 ORDER BY created_at DESC LIMIT 10", user.org_id).map((r) => ({ ...r, context: parse(r.context, {}) })),
    notifications: all("SELECT * FROM notifications WHERE org_id=? ORDER BY created_at DESC LIMIT 10", user.org_id),
  };
}

function providerSettings(org) {
  const anthropic = one("SELECT api_key_enc FROM provider_keys WHERE org_id=? AND provider='anthropic'", org.id);
  return {
    dograh_base_url: org.dograh_base_url || null,
    twilio_from_number: org.twilio_from_number || null,
    telnyx_from_number: org.telnyx_from_number || null,
    configured: {
      dograh: Boolean(org.dograh_base_url && org.dograh_api_key),
      openai: Boolean(getOrgProviderKey(org.id, "openai") || org.openai_api_key),
      anthropic: Boolean(anthropic?.api_key_enc),
      elevenlabs: Boolean(getOrgProviderKey(org.id, "elevenlabs")),
      twilio: Boolean(org.twilio_account_sid && org.twilio_auth_token),
      telnyx: Boolean(org.telnyx_api_key),
    },
  };
}

function providerEncryptionKey() {
  const raw = process.env.SECRETS_KEY;
  if (raw) {
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (key.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes");
    return key;
  }
  if (process.env.NODE_ENV === "production") throw new Error("SECRETS_KEY is required in production");
  return createHash("sha256").update(`secrets:${process.env.AUTH_SECRET || "dev-only-insecure-secret-change-me-32bytes"}`).digest();
}

function encryptProviderKey(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", providerEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1:${[iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(":")}`;
}

function decryptProviderKey(value) {
  if (!value?.startsWith("v1:")) return value || null;
  const [iv, tag, ciphertext] = value.slice(3).split(":").map((part) => Buffer.from(part, "base64url"));
  try {
    const decryptor = createDecipheriv("aes-256-gcm", providerEncryptionKey(), iv);
    decryptor.setAuthTag(tag);
    return Buffer.concat([decryptor.update(ciphertext), decryptor.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function getOrgProviderKey(orgId, provider) {
  const row = one("SELECT api_key_enc FROM provider_keys WHERE org_id=? AND provider=?", orgId, provider);
  return decryptProviderKey(row?.api_key_enc);
}

/**
 * Mints a one-minute OpenAI Realtime client secret for the native app. The
 * organization key is deliberately used only here on the server; the phone
 * receives an ephemeral `ek_` credential, never the long-lived OpenAI key.
 */
async function openAIRealtimeSecret(org, agent, user) {
  const apiKey = agent.openai_api_key || getOrgProviderKey(org.id, "openai") || org.openai_api_key;
  if (!apiKey) return { ok: false, status: 409, error: "Add an OpenAI API key in More → Voice & provider APIs first." };

  const fill = (text) => fillBusiness(text, org.name);
  const instructions = [
    fill(agent.system_prompt),
    agent.persona && `Persona: ${fill(agent.persona)}`,
    agent.goal && `Goal: ${fill(agent.goal)}`,
    agent.greeting && `Start with this greeting: ${fill(agent.greeting)}`,
    languageInstruction(agent.language),
    "You are speaking live in the Adaptive Labs iPhone app. Be helpful, natural, and concise. "
      + "Only answer the person holding the phone. Ignore background voices, TV, music and side conversations.",
  ].filter(Boolean).join("\n\n");

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": sha256(`${org.id}:${user.id}`),
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: "gpt-realtime-2.1",
          audio: {
            input: {
              // The phone is held close to the caller, so near-field filtering
              // drops distant voices and room noise before the model hears them.
              noise_reduction: { type: "near_field" },
              // The default threshold (0.5) let other people talking nearby
              // cut the agent off and start a new reply. Higher needs a louder,
              // closer voice to count as the caller speaking.
              turn_detection: {
                type: "server_vad", threshold: 0.75, prefix_padding_ms: 300, silence_duration_ms: 700,
                create_response: true, interrupt_response: true,
              },
            },
            output: { voice: "marin" },
          },
          instructions,
        },
      }),
    });
  } catch {
    return { ok: false, status: 502, error: "Couldn't reach OpenAI to start Live Voice." };
  }

  if (!response.ok) {
    // Don't expose upstream response details or any credential material to the phone.
    return { ok: false, status: 502, error: `OpenAI couldn't start Live Voice (${response.status}). Check the API key and Realtime access.` };
  }
  const value = await response.json();
  if (typeof value?.value !== "string" || !value.value) {
    return { ok: false, status: 502, error: "OpenAI returned an invalid Live Voice session." };
  }
  return { ok: true, client_secret: value.value, expires_at: value.expires_at ?? null, model: "gpt-realtime-2.1" };
}

// Claude has no speech API: the phone transcribes the caller and speaks the
// reply, and this streams Claude's text so speech can start on the first
// sentence. An agent can still pin its own Claude model in llm_model.
const CLAUDE_VOICE_MODEL = "claude-opus-5-5";
// Models that accept `effort` and the server-side "default" refusal fallback.
const CLAUDE_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
// Fast mode runs the same model up to 2.5x faster at twice the price. On a
// call it cut the first word from ~2.4 s to ~1.3 s for Opus 5.5.
const CLAUDE_FAST_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);

/** The phone's transcript as Messages API turns, or null if the caller hasn't spoken last. */
function claudeVoiceMessages(value) {
  if (!Array.isArray(value)) return null;
  const messages = value
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.text === "string" && m.text.trim())
    .slice(-40)
    .map((m) => ({ role: m.role, content: m.text.trim().slice(0, 4000) }));
  while (messages[0]?.role === "assistant") messages.shift();
  return messages.at(-1)?.role === "user" ? messages : null;
}

/** English name of an agent's language tag ("hi-IN" → "Hindi"). */
function languageName(tag) {
  const code = String(tag || "en").split(/[-_]/)[0].toLowerCase();
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || "English"; } catch { return "English"; }
}

function languageInstruction(tag) {
  const name = languageName(tag);
  return `The call is in ${name}. Speak ${name} unless the caller clearly switches to another language.`;
}

/** Fills the {{business}} placeholder agents are written with. */
function fillBusiness(text, business) {
  return text ? String(text).replaceAll("{{business}}", business || "our business") : text;
}

function claudeVoiceSystem(row) {
  const business = one("SELECT name FROM organizations WHERE id=?", row.org_id)?.name;
  const fill = (text) => fillBusiness(text, business);
  return [
    fill(row.system_prompt),
    row.persona && `Persona: ${fill(row.persona)}`,
    row.goal && `Goal: ${fill(row.goal)}`,
    row.greeting && `You already opened the call with this greeting, so don't greet the caller again: "${fill(row.greeting)}"`,
    languageInstruction(row.language),
    "You are on a live voice call in the Adaptive Labs iPhone app. The caller's words come from speech recognition and everything you write is read aloud. "
      + "Talk like a person on the phone: plain sentences only, no markdown, lists, emojis or links. "
      + "Keep most replies to one to three short sentences and ask one question at a time. "
      + "If the caller's words look garbled, make a sensible guess or ask them to repeat.",
  ].filter(Boolean).join("\n\n");
}

/**
 * Streams Claude's reply as server-sent events: `text` deltas, then `done` or
 * `error`. When Claude can't answer (no key, rate limit, outage) before any
 * text has been sent, ChatGPT answers instead, announced by a `fallback` event.
 */
async function streamClaudeVoice(req, res, apiKey, row, messages) {
  const openAIKey = getOrgProviderKey(row.org_id, "openai") || one("SELECT openai_api_key FROM organizations WHERE id=?", row.org_id)?.openai_api_key;
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const fallBack = async (reason) => {
    if (!openAIKey || res.destroyed) return false;
    send({ type: "fallback", provider: "openai", reason });
    await streamChatGPTVoice(res, send, openAIKey, row, messages);
    return true;
  };
  if (!apiKey) {
    if (!openAIKey) return json(res, 409, { error: "Add an Anthropic or OpenAI API key in More → Voice & provider APIs first." });
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
    await fallBack("No Anthropic key, so ChatGPT is answering.");
    return res.end();
  }
  const model = row.llm_model?.startsWith("claude") ? row.llm_model : CLAUDE_VOICE_MODEL;
  const client = new Anthropic({ apiKey });
  const open = (fast) => {
    const betas = [];
    if (CLAUDE_FALLBACK_MODELS.has(model)) betas.push("server-side-fallback-2026-07-01");
    if (fast) betas.push("fast-mode-2026-02-01");
    return client.beta.messages.stream({
      model,
      max_tokens: 4096,
      system: claudeVoiceSystem(row),
      messages,
      ...(CLAUDE_FALLBACK_MODELS.has(model) && {
        // A quick first sentence matters more on a call than deep reasoning.
        output_config: { effort: "low" },
        fallbacks: "default",
      }),
      ...(fast && { speed: "fast" }),
      ...(betas.length > 0 && { betas }),
    });
  };
  let fast = CLAUDE_FAST_MODELS.has(model);
  let stream = open(fast);
  res.on("close", () => stream.abort());
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
  let started = false;
  try {
    for (;;) {
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            started = true;
            send({ type: "text", text: event.delta.text });
          }
        }
        break;
      } catch (error) {
        // Fast mode has its own rate limit. If it's busy before the reply
        // starts, answer at standard speed instead of failing the turn.
        if (!(fast && !started && error instanceof Anthropic.RateLimitError)) throw error;
        fast = false;
        stream = open(false);
      }
    }
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      if (started || !(await fallBack("Claude declined, so ChatGPT is answering."))) {
        send({ type: "error", error: "Claude declined to answer that. Try asking another way." });
      }
    } else {
      send({ type: "done", model: message.model });
    }
  } catch (error) {
    if (!res.destroyed && (started || !(await fallBack(`${claudeShortReason(error)}, so ChatGPT is answering.`)))) {
      send({ type: "error", error: claudeErrorMessage(error) });
    }
  }
  res.end();
}

/** The same voice reply from ChatGPT, streamed as `text` events then `done` or `error`. */
async function streamChatGPTVoice(res, send, apiKey, row, messages) {
  const org = one("SELECT openai_model FROM organizations WHERE id=?", row.org_id);
  const model = row.llm_model && !row.llm_model.startsWith("claude") ? row.llm_model : org?.openai_model || "gpt-4o-mini";
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: "system", content: claudeVoiceSystem(row) }, ...messages],
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      return send({ type: "error", error: `ChatGPT couldn't reply either (${response.status}). Check the OpenAI key.` });
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:") || line === "data: [DONE]") continue;
        const piece = parse(line.slice(5).trim(), {})?.choices?.[0]?.delta?.content;
        if (piece) send({ type: "text", text: piece });
      }
    }
    send({ type: "done", model });
  } catch {
    if (!res.destroyed) send({ type: "error", error: "Couldn't reach ChatGPT to reply." });
  }
}

/** A few words for the phone's banner when ChatGPT takes over a reply. */
function claudeShortReason(error) {
  if (error instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key";
  if (error instanceof Anthropic.RateLimitError) return "Claude is busy";
  if (error instanceof Anthropic.APIConnectionError) return "Couldn't reach Claude";
  return "Claude couldn't answer";
}

function claudeErrorMessage(error) {
  if (error instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key. Update it in More → Voice & provider APIs.";
  if (error instanceof Anthropic.RateLimitError) return "Claude is busy right now. Try again in a moment.";
  if (error instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic to reply.";
  if (error instanceof Anthropic.APIError) return `Anthropic returned ${error.status ?? "an error"}: ${String(error.message).slice(0, 200)}`;
  return "Claude couldn't reply.";
}

// Agent builder: ports of the web app's src/app/api/agents, src/lib/providers/ai-tools.ts,
// openai.ts (agent copy) and tts.ts, so the phone can create agents against this server.

/** An error the request handler turns into this status and message. */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const AGENT_KINDS = ["lead_qualifier", "appointment_setter", "reception", "follow_up", "review_collector", "reactivation", "survey", "support"];
const AGENT_FIELDS = [
  "name", "kind", "description", "language", "voice", "persona", "goal", "greeting",
  "system_prompt", "max_duration_seconds", "transfer_number", "from_number", "extraction", "status",
  "telephony_provider", "llm_provider", "llm_model", "stt_provider", "tts_provider", "temperature", "tts_model", "stt_model",
];

function requireAgentWrite(user) {
  if (!["owner", "admin", "manager"].includes(user.role)) throw new HttpError(403, "Only owners, admins and managers can change agents.");
}

const LEAD_FIELDS = ["name", "phone", "email", "company", "source", "status", "score", "notes", "consent_sms"];
const LEAD_STATUSES = ["new", "contacted", "qualified", "booked", "won", "lost", "unresponsive", "dnc"];

/** Same roles as `leads:write` and `calls:place` in the web app's RBAC. */
function requireLeadWrite(user) {
  if (!["owner", "admin", "manager", "agent"].includes(user.role)) throw new HttpError(403, "Viewers can't change leads.");
}

function requireCallPlace(user) {
  if (!["owner", "admin", "manager", "agent"].includes(user.role)) throw new HttpError(403, "Viewers can't place calls.");
}

/** Lead columns from a request body; unknown keys are dropped. */
function leadPatch(input) {
  const patch = Object.entries(input).filter(([key]) => LEAD_FIELDS.includes(key));
  for (const [key, value] of patch) {
    if (key === "status" && !LEAD_STATUSES.includes(value)) throw new HttpError(400, `Unknown stage "${value}".`);
    if (key === "name" && !String(value || "").trim()) throw new HttpError(400, "A lead needs a name.");
  }
  return patch.map(([key, value]) => [key, key === "consent_sms" ? (value ? 1 : 0) : typeof value === "string" ? value.trim() : value]);
}

function leadDetail(orgId, leadId) {
  const row = one("SELECT l.*,u.name owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id WHERE l.id=? AND l.org_id=?", leadId, orgId);
  if (!row) return null;
  return {
    lead: lead(row),
    calls: all("SELECT c.*,l.name lead_name,a.name agent_name,a.kind agent_kind FROM calls c LEFT JOIN leads l ON l.id=c.lead_id LEFT JOIN voice_agents a ON a.id=c.agent_id WHERE c.lead_id=? ORDER BY c.created_at DESC LIMIT 50", leadId).map(call),
    messages: all("SELECT * FROM messages WHERE lead_id=? ORDER BY created_at DESC LIMIT 50", leadId),
    bookings: all("SELECT b.*,l.name lead_name,l.phone lead_phone FROM bookings b LEFT JOIN leads l ON l.id=b.lead_id WHERE b.lead_id=? ORDER BY b.starts_at DESC LIMIT 50", leadId),
  };
}

function callWithNames(orgId, callId) {
  return call(one("SELECT c.*,l.name lead_name,a.name agent_name,a.kind agent_kind,au.name automation_name FROM calls c LEFT JOIN leads l ON l.id=c.lead_id LEFT JOIN voice_agents a ON a.id=c.agent_id LEFT JOIN automations au ON au.id=c.automation_id WHERE c.id=? AND c.org_id=?", callId, orgId));
}

/**
 * Why a test call can't really dial, or null when Dograh and a carrier are
 * set up and the agent is live in Dograh. Mirrors `isSimulated` in the web app.
 */
function callBlocker(org, agentRow) {
  const carrier = agentRow.telephony_provider || org.telephony_provider || "twilio";
  if (org.simulation_mode) return "Simulation mode is on for this organization.";
  if (!(getOrgProviderKey(org.id, "dograh") || org.dograh_api_key) || !org.dograh_base_url) return "The voice engine isn't connected yet.";
  if (carrier === "telnyx" ? !(org.telnyx_api_key && org.telnyx_from_number) : !(org.twilio_account_sid && org.twilio_auth_token)) {
    return `${carrier === "telnyx" ? "Telnyx" : "Twilio"} keys aren't set yet.`;
  }
  if (!agentRow.dograh_workflow_id || String(agentRow.dograh_workflow_id).startsWith("sim-")) return "This agent isn't published to a live voice engine yet.";
  return null;
}

const SIM_CALLS = {
  lead_qualifier: "Agent: Hi, this is {agent} calling about your enquiry. Is now an okay time?\nCaller: Yeah, go ahead.\nAgent: What are you looking to get done?\nCaller: We need a new website and online booking.\nAgent: What sort of budget did you have in mind?\nCaller: Around three thousand dollars.\nAgent: Perfect, someone will call you Tuesday with a proposal.\nCaller: Sounds good, thanks.",
  appointment_setter: "Agent: Hi, it's {agent}. I'm calling to get you booked in.\nCaller: Sure, Friday evening works.\nAgent: Friday at seven, does that work?\nCaller: Yes, that's great.\nAgent: You're booked. You'll get a text confirmation.\nCaller: Thank you.",
  default: "Agent: Hi, this is {agent}. Do you have a moment?\nCaller: Sure, what's it about?\nAgent: Just following up on your recent enquiry.\nCaller: Oh yes, can you send me the details?\nAgent: Of course, I'll send them over today.\nCaller: Great, thanks.",
};

/**
 * Plays a test call out without a carrier: ringing, then in progress, then a
 * conversation written by Claude or ChatGPT (a template if neither answers),
 * with a summary and outcome, like a real call's webhook would fill in.
 */
async function simulateTestCall(org, agentRow, leadRow, callId) {
  const started = Date.now();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await wait(3500);
  run("UPDATE calls SET status='in_progress', started_at=? WHERE id=? AND status='ringing'", new Date().toISOString(), callId);
  let result = null;
  try {
    const reply = await aiReply(org, {
      json: true,
      effort: "low",
      system: "You write realistic, short phone call transcripts for testing a voice agent in a CRM.",
      user: `Write a test phone call between a voice agent and a caller.
Agent name: ${agentRow.name}. Agent's job: ${agentRow.goal || agentRow.description || agentRow.kind}.
Agent's opening line: ${agentRow.greeting || "a friendly greeting"}.
Caller: ${leadRow?.name || "the person answering"}${leadRow?.company ? ` from ${leadRow.company}` : ""}.
Return JSON: {"transcript": 6 to 10 lines alternating "Agent: ..." and "Caller: ..." joined with \\n, "summary": one sentence, "disposition": one of booked|interested|not_interested|callback|voicemail|resolved, "sentiment": one of positive|neutral|negative, "score": 0-100 lead score}.`,
    });
    result = JSON.parse(reply.text);
  } catch {
    result = null;
  }
  const transcript = String(result?.transcript || SIM_CALLS[agentRow.kind] || SIM_CALLS.default).replaceAll("{agent}", agentRow.name);
  const disposition = ["booked", "interested", "not_interested", "callback", "voicemail", "resolved"].includes(result?.disposition) ? result.disposition : "interested";
  const sentiment = ["positive", "neutral", "negative"].includes(result?.sentiment) ? result.sentiment : "positive";
  const score = Math.max(0, Math.min(100, Number(result?.score) || 70));
  await wait(Math.max(0, 9000 - (Date.now() - started)));
  const duration = 40 + Math.floor(Math.random() * 120);
  const status = one("SELECT status FROM calls WHERE id=?", callId)?.status;
  if (status !== "in_progress" && status !== "ringing") return; // ended from the phone
  run("UPDATE calls SET status='completed', disposition=?, duration_seconds=?, transcript=?, summary=?, sentiment=?, gathered=?, cost=?, ended_at=? WHERE id=?",
    disposition, duration, transcript, String(result?.summary || "Test call completed."), sentiment, JSON.stringify({ score }),
    Number((duration * 0.013).toFixed(3)), new Date().toISOString(), callId);
  if (leadRow) {
    const stage = { booked: "booked", interested: "qualified", not_interested: "lost", callback: "contacted", voicemail: "unresponsive", resolved: "contacted" }[disposition];
    run("UPDATE leads SET status=?, score=?, attempts=attempts+1, last_contacted_at=?, updated_at=? WHERE id=?",
      stage, score, new Date().toISOString(), new Date().toISOString(), leadRow.id);
  }
}

function audit(user, action, entityType, entityId, meta) {
  run("INSERT INTO audit_log (id,org_id,user_id,action,entity_type,entity_id,meta,created_at) VALUES (?,?,?,?,?,?,?,?)",
    id("aud"), user.org_id, user.id, action, entityType ?? null, entityId ?? null, meta ? JSON.stringify(meta) : null, new Date().toISOString());
}

/** The per-agent key to store: encrypted when newly typed, `undefined` to leave the saved one alone. */
function incomingAgentKey(value, clear = false) {
  if (clear) return null;
  if (typeof value !== "string" || !value.trim() || value.includes("****") || value.includes("••••")) return undefined;
  return encryptProviderKey(value.trim());
}

/**
 * One reply from Claude or ChatGPT. Local databases have no llm_provider
 * setting, so the organization default is whichever has a key, Claude first.
 */
async function aiReply(org, { provider, model, apiKey, system, user, json = false, effort = "medium" }) {
  const anthropicKey = getOrgProviderKey(org.id, "anthropic");
  const chosen = provider === "anthropic" || provider === "openai" ? provider : org.llm_provider || (anthropicKey ? "anthropic" : "openai");
  const instructions = json ? `${system}\nRespond with a single JSON object and nothing else.` : system;
  let text = "";
  let used;
  if (chosen === "anthropic") {
    if (!anthropicKey) throw new HttpError(400, "Add an Anthropic API key in More → Voice & provider APIs first.");
    used = model?.startsWith("claude") ? model : org.anthropic_model || "claude-sonnet-5-5";
    try {
      const message = await new Anthropic({ apiKey: anthropicKey }).beta.messages.create({
        model: used,
        max_tokens: 16000,
        system: instructions,
        messages: [{ role: "user", content: user }],
        output_config: { effort },
        ...(CLAUDE_FALLBACK_MODELS.has(used) && { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
      });
      if (message.stop_reason === "refusal") throw new HttpError(502, "Claude declined to write that. Try describing it another way.");
      text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, claudeErrorMessage(error));
    }
  } else {
    const key = apiKey || getOrgProviderKey(org.id, "openai") || org.openai_api_key;
    if (!key) throw new HttpError(400, "Add an OpenAI API key in More → Voice & provider APIs first.");
    used = model && !model.startsWith("claude") ? model : org.openai_model || "gpt-4o-mini";
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: used,
        ...(json && { response_format: { type: "json_object" } }),
        messages: [{ role: "system", content: instructions }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(90_000),
    }).catch(() => null);
    const payload = await response?.json().catch(() => ({}));
    if (!response?.ok) throw new HttpError(502, `OpenAI ${response ? `returned ${response.status}` : "couldn't be reached"}: ${payload?.error?.message || ""}`.trim());
    text = payload.choices?.[0]?.message?.content || "";
  }
  if (!text.trim()) throw new HttpError(502, "The AI provider returned nothing. Try again.");
  if (json) {
    // The outermost {...} block, in case the model wrapped JSON in prose or a fence.
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }
  return { text, provider: chosen, model: used };
}

/** Greeting and system prompt for a new agent; a template when no model answers. */
async function generateAgentCopy(org, input, overrides) {
  try {
    const { text } = await aiReply(org, {
      ...overrides,
      system: "You write scripts for outbound/inbound voice AI agents. Return JSON with keys greeting and systemPrompt. Short spoken sentences, no markdown, no stage directions.",
      user: JSON.stringify(input),
      json: true,
    });
    const parsed = JSON.parse(text);
    if (parsed.greeting && parsed.systemPrompt) return { greeting: parsed.greeting, systemPrompt: parsed.systemPrompt };
  } catch (error) {
    console.error("[agent copy]", error instanceof Error ? error.message : error);
  }
  return templateCopy(input);
}

function templateCopy(input) {
  const biz = input.business || "the business";
  const greetings = {
    lead_qualifier: `Hi, this is ${input.name} calling from ${biz}. You got in touch about our services — is now an okay time for two quick questions?`,
    appointment_setter: `Hi, this is ${input.name} from ${biz}. I'm calling to get you booked in. Do you have a minute?`,
    reception: `Thanks for calling ${biz}, this is ${input.name}. How can I help you today?`,
    follow_up: `Hi, it's ${input.name} from ${biz}, following up on your enquiry. Is now a good time?`,
    review_collector: `Hi, this is ${input.name} from ${biz}. Thanks for choosing us — I just wanted to check how everything went.`,
    reactivation: `Hi, this is ${input.name} from ${biz}. It's been a while since we last spoke — I wanted to see if you still need a hand.`,
    survey: `Hi, this is ${input.name} from ${biz}. I have three very short questions about your recent visit, if you have a moment.`,
    support: `Thanks for calling ${biz} support, this is ${input.name}. What can I help you sort out?`,
  };
  const systemPrompt = [
    `You are ${input.name}, a voice agent for ${biz}.`,
    input.persona ? `Speak like this: ${input.persona}.` : "Be warm, brief and efficient.",
    `Your goal on this call: ${input.goal || "help the caller and capture their details"}.`,
    "Rules:",
    "- One question at a time, then stop and listen.",
    "- Never promise pricing, availability or legal terms you were not given.",
    "- If asked something you do not know, say you will have a human follow up.",
    "- If the caller asks to be removed from the list, confirm it and end the call.",
    "- Confirm names, phone numbers and dates back to the caller before finishing.",
  ].join("\n");
  return { greeting: greetings[input.kind] || greetings.lead_qualifier, systemPrompt };
}

/** A whole voice agent written from a plain-language description. Nothing is saved. */
async function draftAgent(org, input, overrides) {
  const system = [
    "You design phone voice agents for small businesses.",
    "Given a description, return JSON with exactly these keys:",
    `name (a short human first name), kind (one of ${AGENT_KINDS.join(", ")}),`,
    "description (one sentence), persona (how it speaks, one sentence), goal (what a successful call achieves),",
    "greeting (the first sentence spoken on the call, under 30 words, use {{business}} for the business name),",
    "system_prompt (8-15 short lines: who it is, what to ask, one question at a time, rules for what it must never promise, when to hand over to a human, confirm details back),",
    "language (BCP-47, e.g. en-US),",
    "extraction (3-6 items of {name: snake_case, type: string|number|boolean, prompt: what to extract}).",
    "Spoken style: short sentences, no markdown, no stage directions, no emoji.",
  ].join("\n");
  const user = JSON.stringify({
    business: org.name, description: input.description,
    preferred_kind: input.kind || null, preferred_name: input.name || null, language: input.language || null,
  });
  const reply = await aiReply(org, { ...overrides, system, user, json: true });
  let raw;
  try { raw = JSON.parse(reply.text); } catch { throw new HttpError(502, "The AI reply wasn't valid JSON. Try again."); }
  const draft = {
    name: String(raw.name || input.name || "Ava").slice(0, 40),
    kind: input.kind || (AGENT_KINDS.includes(raw.kind) ? raw.kind : "lead_qualifier"),
    description: String(raw.description || ""),
    persona: String(raw.persona || ""),
    goal: String(raw.goal || ""),
    greeting: String(raw.greeting || ""),
    system_prompt: String(raw.system_prompt || ""),
    language: String(raw.language || input.language || "en-US"),
    extraction: (Array.isArray(raw.extraction) ? raw.extraction : [])
      .filter((x) => x && typeof x.name === "string")
      .slice(0, 8)
      .map((x) => ({
        name: String(x.name).toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 40),
        type: ["string", "number", "boolean"].includes(String(x.type)) ? x.type : "string",
        prompt: String(x.prompt || ""),
      })),
  };
  return { draft, provider: reply.provider, model: reply.model };
}

const REWRITE_STYLES = {
  improve: "Make it clearer, warmer and more natural to say out loud. Keep the meaning.",
  shorter: "Make it noticeably shorter while keeping every important point.",
  friendlier: "Make it friendlier and more relaxed.",
  formal: "Make it more professional and formal.",
  tts: "Rewrite it for text-to-speech: spell out numbers and abbreviations, avoid symbols, use short sentences and natural pauses with commas.",
};

async function rewriteText(org, input, overrides) {
  const how = String(input.instruction || "").trim() || REWRITE_STYLES[input.style] || REWRITE_STYLES.improve;
  const system = [
    `You edit the ${input.field || "text"} of a phone voice agent for ${org.name}.`,
    how,
    "Keep any {{placeholders}} exactly as they are. Return JSON: {\"text\": \"...\"}.",
  ].join("\n");
  const reply = await aiReply(org, { ...overrides, system, user: String(input.text), json: true, effort: "low" });
  try {
    const parsed = JSON.parse(reply.text);
    if (parsed.text) return { text: parsed.text, provider: reply.provider, model: reply.model };
  } catch { /* fall through */ }
  return { text: reply.text.trim(), provider: reply.provider, model: reply.model };
}

const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];
const DEEPGRAM_VOICES = [
  ["aura-2-helena-en", "Helena", "feminine", "American"],
  ["aura-2-thalia-en", "Thalia", "feminine", "American"],
  ["aura-2-andromeda-en", "Andromeda", "feminine", "American"],
  ["aura-2-apollo-en", "Apollo", "masculine", "American"],
  ["aura-2-arcas-en", "Arcas", "masculine", "American"],
  ["aura-2-orion-en", "Orion", "masculine", "American"],
  ["aura-2-draco-en", "Draco", "masculine", "British"],
  ["aura-2-pandora-en", "Pandora", "feminine", "British"],
  ["aura-2-hyperion-en", "Hyperion", "masculine", "Australian"],
  ["aura-2-theia-en", "Theia", "feminine", "Australian"],
].map(([voiceId, name, gender, accent]) => ({ id: voiceId, name, gender, accent, language: "en" }));

function voiceKey(org, provider) {
  const key = getOrgProviderKey(org.id, provider) || (provider === "openai" ? org.openai_api_key : null);
  if (!key) throw new HttpError(400, `Add your ${provider} API key in More → Voice & provider APIs first.`);
  return key;
}

async function failText(response) {
  return (await response.text().catch(() => "")).slice(0, 300) || `HTTP ${response.status}`;
}

/** Voices for one text-to-speech provider: live lists where the provider has one, curated otherwise. */
async function listVoices(org, provider) {
  switch (provider) {
    case "openai":
      return OPENAI_VOICES.map((v) => ({ id: v, name: v[0].toUpperCase() + v.slice(1), language: "multi" }));
    case "deepgram":
      return DEEPGRAM_VOICES;
    case "elevenlabs": {
      const response = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", {
        headers: { "xi-api-key": voiceKey(org, "elevenlabs") }, signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new HttpError(502, `ElevenLabs: ${await failText(response)}`);
      return ((await response.json()).voices || []).map((v) => ({
        id: v.voice_id, name: v.name,
        description: v.description ?? v.labels?.description ?? null,
        gender: v.labels?.gender ?? null, accent: v.labels?.accent ?? null, language: v.labels?.language ?? null,
        preview_url: v.preview_url ?? null,
      }));
    }
    case "cartesia": {
      const response = await fetch("https://api.cartesia.ai/voices?limit=100", {
        headers: { "X-API-Key": voiceKey(org, "cartesia"), "Cartesia-Version": "2025-04-16" }, signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new HttpError(502, `Cartesia: ${await failText(response)}`);
      const payload = await response.json();
      return (Array.isArray(payload) ? payload : payload.data || []).map((v) => ({
        id: v.id, name: v.name, description: v.description ?? null, gender: v.gender ?? null, language: v.language ?? null,
      }));
    }
    default:
      throw new HttpError(400, `Unknown voice provider "${provider}"`);
  }
}

/** A short spoken sample as MP3 bytes. */
async function synthesize(org, input) {
  const text = input.text.slice(0, 600);
  let response;
  switch (input.provider) {
    case "openai":
      response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${voiceKey(org, "openai")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: input.model || "gpt-4o-mini-tts", voice: input.voice || "alloy", input: text, response_format: "mp3" }),
        signal: AbortSignal.timeout(60_000),
      });
      break;
    case "elevenlabs":
      response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voice || "21m00Tcm4TlvDq8ikWAM")}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": voiceKey(org, "elevenlabs"), "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: input.model || "eleven_flash_v2_5" }),
        signal: AbortSignal.timeout(60_000),
      });
      break;
    case "cartesia":
      response = await fetch("https://api.cartesia.ai/tts/bytes", {
        method: "POST",
        headers: { "X-API-Key": voiceKey(org, "cartesia"), "Cartesia-Version": "2025-04-16", "Content-Type": "application/json" },
        body: JSON.stringify({
          model_id: input.model || "sonic-3.5", transcript: text,
          voice: { mode: "id", id: input.voice || "3faa81ae-d3d8-4ab1-9e44-e50e46d33c30" },
          language: (input.language || "en").slice(0, 2),
          output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      break;
    case "deepgram":
      response = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(input.voice || "aura-2-helena-en")}&encoding=mp3`, {
        method: "POST",
        headers: { Authorization: `Token ${voiceKey(org, "deepgram")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(60_000),
      });
      break;
    default:
      throw new HttpError(400, `Voice previews aren't available for "${input.provider}"`);
  }
  if (!response.ok) throw new HttpError(502, `${input.provider}: ${await failText(response)}`);
  return { audio: await response.arrayBuffer(), contentType: response.headers.get("content-type") || "audio/mpeg" };
}

// Live voice on the ElevenLabs free plan. Free accounts can't use library
// voices through the API (402 paid_plan_required; the old default "Rachel" is
// now one), only the account's premade, cloned or generated voices, and get
// 10,000 credits a month. Flash v2.5 is the cheapest model that streams over
// the websocket, so its languages are the ones live calls can speak.
const ELEVEN_LIVE_MODEL = "eleven_flash_v2_5";
const FREE_PLAN_VOICE_CATEGORIES = new Set(["premade", "cloned", "generated"]);
const elevenCache = new Map();

/** Fetches JSON from ElevenLabs, cached per key for `ttl` ms. */
async function elevenGet(key, path, ttl) {
  const cacheKey = `${sha256(key)}:${path}`;
  const hit = elevenCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const response = await fetch(`https://api.elevenlabs.io${path}`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new HttpError(502, `ElevenLabs: ${await failText(response)}`);
  const value = await response.json();
  elevenCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/** Languages the live model speaks, as [{code, name}] with 639-1 codes ("hi", "fil"). */
async function elevenLiveModelLanguages(key) {
  const models = await elevenGet(key, "/v1/models", 3_600_000);
  const live = (Array.isArray(models) ? models : []).find((m) => m.model_id === ELEVEN_LIVE_MODEL);
  return (live?.languages || []).map((l) => ({ code: l.language_id, name: l.name }));
}

// What ChatGPT's realtime voice handles well, offered when ElevenLabs isn't connected or doesn't answer.
const CHATGPT_LANGUAGES = ["en", "hi", "ur", "bn", "ta", "te", "mr", "gu", "kn", "ml", "pa", "ar", "es", "fr", "de", "pt", "it",
  "nl", "ru", "uk", "pl", "tr", "fa", "he", "ja", "ko", "zh", "id", "ms", "fil", "vi", "th", "sv", "da", "no", "fi", "el", "cs", "ro", "hu", "sw"]
  .map((code) => ({ code, name: languageName(code) }));

/** The language picker's list: ElevenLabs' live model when it answers, ChatGPT's otherwise. */
async function liveLanguages(orgId) {
  const key = getOrgProviderKey(orgId, "elevenlabs");
  if (key) {
    try {
      const languages = await elevenLiveModelLanguages(key);
      if (languages.length) return { source: "elevenlabs", model: ELEVEN_LIVE_MODEL, languages };
    } catch { /* fall through to ChatGPT's list */ }
  }
  return { source: "chatgpt", model: null, languages: CHATGPT_LANGUAGES };
}

/**
 * A single-use ElevenLabs websocket token plus a voice this account's plan can
 * actually use. Throws 402 when the plan can't speak (credits used up, no
 * usable voice) so the phone switches to ChatGPT's voice before the call starts.
 */
async function elevenLabsLiveSpeech(orgId, agentRow, language) {
  const key = getOrgProviderKey(orgId, "elevenlabs");
  if (!key) throw new HttpError(409, "Add an ElevenLabs API key in More → Voice & provider APIs first.");
  // Everything is fetched at once: done one after another, these calls took
  // up to 9 s on a busy Mac, all of it silence on the call.
  const tokenRequest = fetch("https://api.elevenlabs.io/v1/single-use-token/tts_websocket", {
    method: "POST", headers: { "xi-api-key": key }, signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const [plan, voices, languages] = await Promise.all([
    elevenGet(key, "/v1/user/subscription", 60_000),
    elevenGet(key, "/v2/voices?page_size=100", 600_000),
    elevenLiveModelLanguages(key).catch(() => []),
  ]);
  const left = plan.character_limit ? Math.max(0, plan.character_limit - (plan.character_count || 0)) : null;
  if (left !== null && left < 50) {
    throw new HttpError(402, `ElevenLabs credits are used up on the ${plan.tier || "current"} plan until they reset, so ChatGPT's voice is speaking instead.`);
  }
  const usable = (voices.voices || []).filter((v) => plan.tier !== "free" || FREE_PLAN_VOICE_CATEGORIES.has(v.category));
  const code = String(language || "en").split(/[-_]/)[0].toLowerCase();
  const wanted = agentRow?.tts_provider === "elevenlabs" ? agentRow.voice : null;
  const voice = usable.find((v) => v.voice_id === wanted)
    ?? usable.find((v) => v.category === "premade" && v.labels?.language === code)
    ?? usable.find((v) => v.category === "premade")
    ?? usable[0];
  if (!voice) throw new HttpError(402, "This ElevenLabs plan has no voices it can use through the API, so ChatGPT's voice is speaking instead.");
  const tokenResponse = await tokenRequest;
  const payload = await tokenResponse?.json().catch(() => ({}));
  if (!tokenResponse?.ok || typeof payload?.token !== "string") {
    throw new HttpError(502, "ElevenLabs couldn't start its realtime speech connection. Check the API key and account access.");
  }
  return {
    token: payload.token,
    voice_id: voice.voice_id,
    voice_name: voice.name,
    model: ELEVEN_LIVE_MODEL,
    // Pins pronunciation to the agent's language when the model supports it.
    language_code: languages.some((l) => l.code === code) ? code : null,
    plan: plan.tier || null,
    credits_left: left,
    // The agent's own voice is a library voice the plan can't use.
    voice_replaced: Boolean(wanted && wanted !== voice.voice_id),
  };
}

/** One sentence in ChatGPT's voice, for when ElevenLabs can't speak. The OpenAI response, body unread. */
async function chatGPTSpeech(org, agentRow, text, format = "mp3", signal = AbortSignal.timeout(30_000)) {
  const voice = agentRow.tts_provider === "openai" && OPENAI_VOICES.includes(agentRow.voice) ? agentRow.voice : "coral";
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${voiceKey(org, "openai")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts", voice, input: text.slice(0, 1200), response_format: format,
      instructions: `Speak ${languageName(agentRow.language)} naturally, like a friendly person on a phone call.`,
    }),
    signal,
  }).catch(() => null);
  if (!response?.ok || !response.body) throw new HttpError(502, `ChatGPT's voice ${response ? `returned ${response.status}` : "couldn't be reached"}.`);
  return response;
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) { chunks.push(chunk); if (Buffer.concat(chunks).length > 128000) throw new Error("Request too large"); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { throw new Error("Invalid JSON"); }
}

createServer(async (req, res) => {
  const originalEnd = res.end.bind(res);
  let ending = false;
  res.end = function (...args) {
    if (ending) return res;
    ending = true;
    if (!pool) return originalEnd(...args);
    void persistDatabase().then(() => originalEnd(...args)).catch((error) => {
      console.error("[persistence] snapshot failed", error.message);
      if (!res.headersSent) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        originalEnd(JSON.stringify({ error: "Storage unavailable; please retry" }));
      } else originalEnd();
    });
    return res;
  };
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = url.pathname.replace(/^\/api\/v1/, "");
    if (!url.pathname.startsWith("/api/v1/")) return json(res, 404, { error: "Not found" });
    if (req.method === "GET" && route === "/meta") {
      return json(res, 200, { name: "Adaptive Labs", version: "1", demo: true, demo_users: [{ email: DEMO_EMAIL, name: "Demo Owner", role: "owner" }] });
    }
    if (req.method === "POST" && route === "/auth/login") {
      const input = await body(req);
      const row = one("SELECT id,org_id,email,name,role,password_hash,active FROM users WHERE email=?", String(input.email || "").trim().toLowerCase());
      if (!row?.active || !(await bcrypt.compare(String(input.password || ""), row.password_hash))) return json(res, 401, { error: "Invalid email or password" });
      const user = { id: row.id, org_id: row.org_id, email: row.email, name: row.name, role: row.role };
      const org = one("SELECT name FROM organizations WHERE id=?", user.org_id);
      return json(res, 200, { ...(await tokens(user)), user, org_name: org?.name || "CRM" });
    }
    if (req.method === "POST" && route === "/auth/refresh") {
      const input = await body(req);
      const session = one("SELECT * FROM sessions WHERE token_hash=? AND revoked_at IS NULL", sha256(String(input.refresh_token || "")));
      if (!session || session.expires_at < new Date().toISOString()) return json(res, 401, { error: "Session expired. Sign in again." });
      const row = one("SELECT id,org_id,email,name,role,active FROM users WHERE id=?", session.user_id);
      if (!row?.active) return json(res, 401, { error: "Account disabled" });
      run("UPDATE sessions SET revoked_at=? WHERE id=?", new Date().toISOString(), session.id);
      return json(res, 200, await tokens(row, session.family_id));
    }
    const user = await current(req);
    if (!user) return json(res, 401, { error: "Not authenticated" });
    if (req.method === "GET" && route === "/auth/me") {
      const org = one("SELECT name FROM organizations WHERE id=?", user.org_id);
      return json(res, 200, { user, org_name: org?.name || "CRM" });
    }
    if (req.method === "GET" && route === "/dashboard") return json(res, 200, dashboard(user));
    if (route === "/settings/providers") {
      if (!["owner", "admin"].includes(user.role)) return json(res, 403, { error: "Only owners and admins can update provider settings." });
      if (req.method === "GET") {
        return json(res, 200, providerSettings(one("SELECT * FROM organizations WHERE id=?", user.org_id)));
      }
      if (req.method === "PATCH") {
        if (user.org_id === DEMO_ORG_ID) return json(res, 403, { error: "Provider settings are unavailable in the shared demo. Use your private account for API keys." });
        const input = await body(req);
        const allowed = new Set([
          "dograh_base_url", "dograh_api_key", "openai_api_key", "twilio_account_sid",
          "twilio_auth_token", "twilio_from_number", "telnyx_api_key", "telnyx_from_number", "anthropic_api_key", "elevenlabs_api_key",
        ]);
        const updates = Object.entries(input)
          .filter(([key, value]) => allowed.has(key) && typeof value === "string" && value.trim().length > 0);
        const secureProviderKeys = new Map([
          ["anthropic_api_key", "anthropic"],
          ["elevenlabs_api_key", "elevenlabs"],
        ]);
        const encryptedUpdates = updates.filter(([key]) => secureProviderKeys.has(key));
        const orgUpdates = updates.filter(([key]) => !secureProviderKeys.has(key));
        if (orgUpdates.length) {
          run(`UPDATE organizations SET ${orgUpdates.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`,
            ...orgUpdates.map(([, value]) => value.trim()), user.org_id);
        }
        for (const [field, value] of encryptedUpdates) {
          const clean = value.trim();
          const provider = secureProviderKeys.get(field);
          run(`INSERT INTO provider_keys (org_id,provider,api_key_enc,last4,updated_by,updated_at)
            VALUES (?,?,?,?,?,?) ON CONFLICT(org_id,provider) DO UPDATE SET
            api_key_enc=excluded.api_key_enc,last4=excluded.last4,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
            user.org_id, provider, encryptProviderKey(clean), clean.slice(-4), user.id, new Date().toISOString());
        }
        return json(res, 200, providerSettings(one("SELECT * FROM organizations WHERE id=?", user.org_id)));
      }
      return json(res, 405, { error: "Method not allowed" });
    }
    if (req.method === "GET" && route === "/leads") {
      const rows = all("SELECT l.*,u.name owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id WHERE l.org_id=? ORDER BY l.updated_at DESC, l.created_at DESC", user.org_id);
      return json(res, 200, { leads: rows.map(lead) });
    }
    if (req.method === "GET" && route === "/calls") {
      const rows = all("SELECT c.*,l.name lead_name,a.name agent_name,a.kind agent_kind,au.name automation_name FROM calls c LEFT JOIN leads l ON l.id=c.lead_id LEFT JOIN voice_agents a ON a.id=c.agent_id LEFT JOIN automations au ON au.id=c.automation_id WHERE c.org_id=? ORDER BY c.created_at DESC LIMIT 80", user.org_id);
      return json(res, 200, { calls: rows.map(call) });
    }
    if (req.method === "GET" && route === "/bookings") {
      const rows = all("SELECT b.*,l.name lead_name,l.phone lead_phone FROM bookings b LEFT JOIN leads l ON l.id=b.lead_id WHERE b.org_id=? ORDER BY b.starts_at DESC LIMIT 80", user.org_id);
      return json(res, 200, { bookings: rows });
    }
    if (req.method === "GET" && route === "/messages") {
      const rows = all("SELECT m.*,l.name lead_name,a.name automation_name FROM messages m LEFT JOIN leads l ON l.id=m.lead_id LEFT JOIN automations a ON a.id=m.automation_id WHERE m.org_id=? ORDER BY m.created_at DESC LIMIT 80", user.org_id);
      return json(res, 200, { messages: rows });
    }
    if (req.method === "POST" && route === "/leads") {
      requireLeadWrite(user);
      const patch = leadPatch(await body(req));
      if (!patch.some(([key]) => key === "name")) return json(res, 400, { error: "A lead needs a name." });
      const leadId = id("lead");
      const now = new Date().toISOString();
      const values = Object.fromEntries(patch);
      run("INSERT INTO leads (id,org_id,name,phone,email,company,source,status,score,notes,consent_sms,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        leadId, user.org_id, values.name, values.phone || null, values.email || null, values.company || null, values.source || "manual",
        values.status || "new", Number(values.score) || 0, values.notes || null, values.consent_sms ?? 1, user.id, now, now);
      audit(user, "lead.create", "lead", leadId);
      return json(res, 200, { lead_id: leadId, automation_runs: [] });
    }
    const leadMatch = route.match(/^\/leads\/([^/]+)$/);
    if (req.method === "GET" && leadMatch) {
      const detail = leadDetail(user.org_id, leadMatch[1]);
      return detail ? json(res, 200, detail) : json(res, 404, { error: "Lead not found" });
    }
    if (req.method === "PATCH" && leadMatch) {
      requireLeadWrite(user);
      const patch = leadPatch(await body(req));
      if (!patch.length) return json(res, 400, { error: "Nothing to update" });
      const result = run(`UPDATE leads SET ${patch.map(([key]) => `${key}=?`).join(", ")}, updated_at=? WHERE id=? AND org_id=?`,
        ...patch.map(([, value]) => value), new Date().toISOString(), leadMatch[1], user.org_id);
      if (!result.changes) return json(res, 404, { error: "Lead not found" });
      audit(user, "lead.update", "lead", leadMatch[1], { fields: patch.map(([key]) => key) });
      return json(res, 200, leadDetail(user.org_id, leadMatch[1]));
    }
    if (req.method === "DELETE" && leadMatch) {
      requireLeadWrite(user);
      run("DELETE FROM leads WHERE id=? AND org_id=?", leadMatch[1], user.org_id);
      audit(user, "lead.delete", "lead", leadMatch[1]);
      return json(res, 200, { ok: true });
    }
    const callMatch = route.match(/^\/calls\/([^/]+)$/);
    if (req.method === "GET" && callMatch) {
      const row = callWithNames(user.org_id, callMatch[1]);
      return row ? json(res, 200, { call: row }) : json(res, 404, { error: "Call not found" });
    }
    const callEndMatch = route.match(/^\/calls\/([^/]+)\/end$/);
    if (req.method === "POST" && callEndMatch) {
      requireCallPlace(user);
      // Only simulated calls can be ended from here; real ones end on the phone.
      run("UPDATE calls SET status='completed', disposition=COALESCE(disposition,'callback'), summary=COALESCE(summary,'Ended from the app before the end of the test.'), ended_at=? WHERE id=? AND org_id=? AND simulated=1 AND status IN ('ringing','in_progress')",
        new Date().toISOString(), callEndMatch[1], user.org_id);
      return json(res, 200, { call: callWithNames(user.org_id, callEndMatch[1]) });
    }
    const testCallMatch = route.match(/^\/agents\/([^/]+)\/test-call$/);
    if (req.method === "POST" && testCallMatch) {
      requireCallPlace(user);
      const input = await body(req);
      const agentRow = one("SELECT * FROM voice_agents WHERE id=? AND org_id=?", testCallMatch[1], user.org_id);
      if (!agentRow) return json(res, 404, { error: "Agent not found" });
      const org = one("SELECT * FROM organizations WHERE id=?", user.org_id);
      const leadRow = input.lead_id ? one("SELECT * FROM leads WHERE id=? AND org_id=?", String(input.lead_id), user.org_id) : null;
      if (input.lead_id && !leadRow) return json(res, 404, { error: "Lead not found" });
      if (leadRow?.status === "dnc") return json(res, 400, { error: `${leadRow.name} is on the do-not-call list.` });
      const to = String(input.phone || leadRow?.phone || "").replace(/[\s()-]/g, "");
      if (!/^\+[1-9]\d{7,14}$/.test(to)) return json(res, 400, { error: "Use the full number with country code, like +14155550100." });
      const carrier = agentRow.telephony_provider || org.telephony_provider || "twilio";
      const from = agentRow.from_number || (carrier === "telnyx" ? org.telnyx_from_number : org.twilio_from_number) || null;
      const blocker = callBlocker(org, agentRow);
      const callId = id("call");
      const now = new Date().toISOString();
      if (blocker) {
        run("INSERT INTO calls (id,org_id,lead_id,agent_id,direction,provider,to_number,from_number,status,simulated,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          callId, user.org_id, leadRow?.id || null, agentRow.id, "outbound", "simulated", to, from, "ringing", 1, now);
        audit(user, "call.manual", "call", callId, { agent: agentRow.id, simulated: true });
        simulateTestCall(org, agentRow, leadRow, callId).catch((error) => console.error("test call simulation", error));
        return json(res, 200, { call: callWithNames(user.org_id, callId), simulated: true, reason: blocker });
      }
      const base = String(org.dograh_base_url).replace(/\/$/, "");
      const response = await fetch(`${base}/api/v1/initiate-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": getOrgProviderKey(org.id, "dograh") || org.dograh_api_key },
        body: JSON.stringify({
          workflow_id: Number(agentRow.dograh_workflow_id) || agentRow.dograh_workflow_id,
          phone_number: to,
          initial_context: { lead_id: leadRow?.id, customer_name: leadRow?.name, crm_call_id: callId },
        }),
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);
      const payload = await response?.json().catch(() => ({}));
      run("INSERT INTO calls (id,org_id,lead_id,agent_id,direction,provider,dograh_run_id,to_number,from_number,status,simulated,started_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        callId, user.org_id, leadRow?.id || null, agentRow.id, "outbound", `dograh+${carrier}`, payload?.run_id ? String(payload.run_id) : null,
        to, from, response?.ok ? "ringing" : "failed", 0, now, now);
      audit(user, "call.manual", "call", callId, { agent: agentRow.id, simulated: false });
      if (!response?.ok) {
        return json(res, 502, { error: `The voice engine ${response ? `returned ${response.status}` : "couldn't be reached"}. ${payload?.detail || payload?.error || ""}`.trim() });
      }
      return json(res, 200, { call: callWithNames(user.org_id, callId), simulated: false, reason: null });
    }
    const openAIVoiceMatch = route.match(/^\/agents\/([^/]+)\/demo\/openai-voice$/);
    if (req.method === "POST" && openAIVoiceMatch) {
      const row = one("SELECT * FROM voice_agents WHERE id=? AND org_id=?", openAIVoiceMatch[1], user.org_id);
      if (!row) return json(res, 404, { error: "Agent not found" });
      const org = one("SELECT * FROM organizations WHERE id=?", user.org_id);
      const realtime = await openAIRealtimeSecret(org, row, user);
      if (!realtime.ok) return json(res, realtime.status, { error: realtime.error });
      return json(res, 200, {
        client_secret: realtime.client_secret,
        expires_at: realtime.expires_at,
        model: realtime.model,
      });
    }
    const claudeVoiceMatch = route.match(/^\/agents\/([^/]+)\/demo\/claude-voice$/);
    if (req.method === "POST" && claudeVoiceMatch) {
      const input = await body(req);
      const messages = claudeVoiceMessages(input.messages);
      if (!messages) return json(res, 400, { error: "Say something first, then Claude will answer." });
      const row = one("SELECT * FROM voice_agents WHERE id=? AND org_id=?", claudeVoiceMatch[1], user.org_id);
      if (!row) return json(res, 404, { error: "Agent not found" });
      return streamClaudeVoice(req, res, getOrgProviderKey(user.org_id, "anthropic"), row, messages);
    }
    // The same hands-free turn with ChatGPT as the brain, so ChatGPT agents also
    // get the phone's "only hear the caller" listening instead of OpenAI
    // Realtime, which reacts to every voice near the mic.
    const chatGPTVoiceMatch = route.match(/^\/agents\/([^/]+)\/demo\/chatgpt-voice$/);
    if (req.method === "POST" && chatGPTVoiceMatch) {
      const input = await body(req);
      const messages = claudeVoiceMessages(input.messages);
      if (!messages) return json(res, 400, { error: "Say something first, then the agent will answer." });
      const row = one("SELECT * FROM voice_agents WHERE id=? AND org_id=?", chatGPTVoiceMatch[1], user.org_id);
      if (!row) return json(res, 404, { error: "Agent not found" });
      const openAIKey = getOrgProviderKey(user.org_id, "openai") || one("SELECT openai_api_key FROM organizations WHERE id=?", user.org_id)?.openai_api_key;
      // Without an OpenAI key, Claude answers instead.
      if (!openAIKey) return streamClaudeVoice(req, res, getOrgProviderKey(user.org_id, "anthropic"), row, messages);
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
      await streamChatGPTVoice(res, (event) => res.write(`data: ${JSON.stringify(event)}\n\n`), openAIKey, row, messages);
      return res.end();
    }
    const speechMatch = route.match(/^\/agents\/([^/]+)\/demo\/speech$/);
    if (req.method === "POST" && speechMatch) {
      const input = await body(req);
      const text = String(input.text || "").trim();
      if (!text) return json(res, 400, { error: "Nothing to say" });
      const row = one("SELECT * FROM voice_agents WHERE id=? AND org_id=?", speechMatch[1], user.org_id);
      if (!row) return json(res, 404, { error: "Agent not found" });
      const org = one("SELECT * FROM organizations WHERE id=?", user.org_id);
      const pcm = input.format === "pcm";
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const response = await chatGPTSpeech(org, row, text, pcm ? "pcm" : "mp3", controller.signal);
      // PCM (24 kHz, 16-bit, mono) is passed through as OpenAI streams it,
      // so the phone starts playing before the whole sentence is synthesized.
      res.writeHead(200, { "Content-Type": pcm ? "audio/pcm" : "audio/mpeg", "Cache-Control": "no-store" });
      try {
        for await (const chunk of response.body) res.write(chunk);
      } catch { /* the phone hung up */ }
      return res.end();
    }
    if (req.method === "POST" && route === "/debug/voice-trace") {
      // Debug builds of the app send what happened during a live call, so a
      // failed call can be read back here instead of guessed at.
      const input = await body(req);
      const events = Array.isArray(input.events) ? input.events.slice(0, 500) : [];
      const lines = events.map((event) => JSON.stringify({ user: user.email, ...event })).join("\n");
      if (lines) appendFileSync(path.join(dataDir, "voice-trace.log"), lines + "\n");
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && route === "/languages") {
      return json(res, 200, await liveLanguages(user.org_id));
    }
    if (req.method === "POST" && route === "/providers/elevenlabs/tts-token") {
      const input = await body(req);
      const row = input.agent_id ? one("SELECT * FROM voice_agents WHERE id=? AND org_id=?", String(input.agent_id), user.org_id) : null;
      return json(res, 200, await elevenLabsLiveSpeech(user.org_id, row, input.language || row?.language));
    }
    if (req.method === "GET" && route === "/agents") {
      const rows = all("SELECT a.*,COUNT(c.id) call_count FROM voice_agents a LEFT JOIN calls c ON c.agent_id=a.id WHERE a.org_id=? GROUP BY a.id ORDER BY a.updated_at DESC", user.org_id);
      return json(res, 200, { agents: rows.map(agent) });
    }
    if (req.method === "POST" && route === "/agents") {
      requireAgentWrite(user);
      const input = await body(req);
      if (user.org_id === DEMO_ORG_ID && input.openai_api_key) return json(res, 403, { error: "Do not add API keys to the shared demo." });
      const name = String(input.name || "").trim();
      if (!name) return json(res, 400, { error: "Agent name is required" });
      const org = one("SELECT * FROM organizations WHERE id=?", user.org_id);
      const kind = String(input.kind || "lead_qualifier");
      let greeting = String(input.greeting || "");
      let systemPrompt = String(input.system_prompt || "");
      let generated = false;
      if (!greeting || !systemPrompt) {
        const copy = await generateAgentCopy(org, { name, kind, goal: String(input.goal || ""), persona: String(input.persona || ""), business: org.name }, {
          provider: input.llm_provider, model: input.llm_model,
          apiKey: input.llm_provider !== "anthropic" ? input.openai_api_key : null,
        });
        greeting ||= copy.greeting;
        systemPrompt ||= copy.systemPrompt;
        generated = true;
      }
      const agentId = id("va");
      const now = new Date().toISOString();
      run(`INSERT INTO voice_agents (id,org_id,name,kind,description,language,voice,persona,goal,greeting,system_prompt,max_duration_seconds,
          transfer_number,from_number,telephony_provider,llm_provider,llm_model,openai_api_key,stt_provider,tts_provider,temperature,extraction,
          status,created_by,created_at,updated_at,tts_model,stt_model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        agentId, user.org_id, name, kind, input.description || null, input.language || "en-US", input.voice || "alloy",
        input.persona || null, input.goal || null, greeting, systemPrompt, Number(input.max_duration_seconds ?? 300),
        input.transfer_number || null, input.from_number || null, input.telephony_provider || null, input.llm_provider || "openai",
        input.llm_model || null, incomingAgentKey(input.openai_api_key) ?? null, input.stt_provider || null, input.tts_provider || null,
        input.temperature != null ? Number(input.temperature) : 0.4, JSON.stringify(input.extraction ?? []),
        "draft", user.id, now, now, input.tts_model || null, input.stt_model || null);
      audit(user, "agent.create", "voice_agent", agentId, { generated });
      return json(res, 201, { agent_id: agentId, generated_copy: generated });
    }
    if (req.method === "POST" && route === "/ai/agent-draft") {
      requireAgentWrite(user);
      const input = await body(req);
      const description = String(input.description || "").trim();
      if (description.length < 8) return json(res, 400, { error: "Describe the business and what the agent should do" });
      const org = one("SELECT * FROM organizations WHERE id=?", user.org_id);
      const result = await draftAgent(org, { description, kind: input.kind, name: input.name, language: input.language }, { provider: input.provider, model: input.model });
      audit(user, "ai.agent_draft", "voice_agent", null, { provider: result.provider, model: result.model });
      return json(res, 200, result);
    }
    if (req.method === "POST" && route === "/ai/rewrite") {
      requireAgentWrite(user);
      const input = await body(req);
      if (!String(input.text || "").trim()) return json(res, 400, { error: "Nothing to rewrite" });
      const org = one("SELECT * FROM organizations WHERE id=?", user.org_id);
      return json(res, 200, await rewriteText(org, input, { provider: input.provider, model: input.model }));
    }
    if (req.method === "GET" && route === "/voices") {
      const provider = url.searchParams.get("provider") || "openai";
      const org = one("SELECT * FROM organizations WHERE id=?", user.org_id);
      return json(res, 200, { provider, voices: await listVoices(org, provider) });
    }
    if (req.method === "POST" && route === "/tts/preview") {
      const input = await body(req);
      const org = one("SELECT * FROM organizations WHERE id=?", user.org_id);
      const { audio, contentType } = await synthesize(org, {
        provider: input.provider || "openai", voice: input.voice, model: input.model, language: input.language,
        text: String(input.text || "").trim() || "Hi, thanks for calling. How can I help you today?",
      });
      res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
      return res.end(Buffer.from(audio));
    }
    const publishMatch = route.match(/^\/agents\/([^/]+)\/publish$/);
    if (req.method === "POST" && publishMatch) {
      requireAgentWrite(user);
      const row = one("SELECT * FROM voice_agents WHERE id=? AND org_id=?", publishMatch[1], user.org_id);
      if (!row) return json(res, 404, { error: "Agent not found" });
      const org = one("SELECT * FROM organizations WHERE id=?", user.org_id);
      // Sending agents to a real Dograh server is only implemented in the web app.
      if (getOrgProviderKey(org.id, "dograh") || org.dograh_api_key) {
        return json(res, 501, { error: "Publishing to a live voice engine needs the full web app (npm run dev)." });
      }
      const workflowId = row.dograh_workflow_id?.startsWith("sim-") ? row.dograh_workflow_id : `sim-wf-${randomBytes(3).toString("hex")}`;
      run("UPDATE voice_agents SET dograh_workflow_id=?, dograh_published=1, status='published', updated_at=? WHERE id=?", workflowId, new Date().toISOString(), row.id);
      audit(user, "agent.publish", "voice_agent", row.id, { workflowId, warnings: [] });
      return json(res, 200, { workflow_id: workflowId, simulated: true, calls_simulated: true, warnings: [] });
    }
    const match = route.match(/^\/agents\/([^/]+)$/);
    if (req.method === "GET" && match) {
      const row = one("SELECT a.*,COUNT(c.id) call_count FROM voice_agents a LEFT JOIN calls c ON c.agent_id=a.id WHERE a.id=? AND a.org_id=? GROUP BY a.id", match[1], user.org_id);
      if (!row) return json(res, 404, { error: "Agent not found" });
      return json(res, 200, { agent: agent(row), calls: all("SELECT * FROM calls WHERE agent_id=? ORDER BY created_at DESC LIMIT 20", row.id), automations: all("SELECT id,name,type,enabled FROM automations WHERE agent_id=?", row.id) });
    }
    if (req.method === "PATCH" && match) {
      requireAgentWrite(user);
      const input = await body(req);
      if (user.org_id === DEMO_ORG_ID && input.openai_api_key) return json(res, 403, { error: "Do not add API keys to the shared demo." });
      const patch = Object.entries(input).filter(([key]) => AGENT_FIELDS.includes(key));
      // The key is only replaced by a real new value, or cleared on purpose.
      const key = incomingAgentKey(input.openai_api_key, input.clear_openai_api_key === true);
      if (key !== undefined) patch.push(["openai_api_key", key]);
      if (!patch.length) return json(res, 400, { error: "Nothing to update" });
      const result = run(`UPDATE voice_agents SET ${patch.map(([k]) => `${k}=?`).join(", ")}, updated_at=? WHERE id=? AND org_id=?`,
        ...patch.map(([k, v]) => (k === "extraction" ? JSON.stringify(v) : v)), new Date().toISOString(), match[1], user.org_id);
      if (!result.changes) return json(res, 404, { error: "Agent not found" });
      audit(user, "agent.update", "voice_agent", match[1]);
      return json(res, 200, { agent: agent(one("SELECT * FROM voice_agents WHERE id=? AND org_id=?", match[1], user.org_id)) });
    }
    if (req.method === "DELETE" && match) {
      requireAgentWrite(user);
      run("DELETE FROM voice_agents WHERE id=? AND org_id=?", match[1], user.org_id);
      audit(user, "agent.delete", "voice_agent", match[1]);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "This mobile endpoint is not available locally." });
  } catch (error) {
    if (error instanceof HttpError) return json(res, error.status, { error: error.message });
    console.error(error);
    return json(res, 500, { error: error instanceof Error ? error.message : "Server error" });
  }
}).listen(port, "0.0.0.0", () => console.log(`Adaptive Labs mobile API listening on http://0.0.0.0:${port}`));
