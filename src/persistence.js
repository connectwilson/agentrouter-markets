let poolPromise = null;
let schemaReady = false;

export function persistenceEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

export function persistentRegistryRequired() {
  return process.env.ADN_REQUIRE_PERSISTENT_REGISTRY === "true" || Boolean(process.env.RENDER);
}

export function providerSecretPassphraseConfigured() {
  return Boolean(process.env.ADN_PROVIDER_SECRET_PASSPHRASE);
}

export function assertPersistentProviderStorageReady({ requiresSecret = false } = {}) {
  if (persistentRegistryRequired() && !persistenceEnabled()) {
    const error = new Error("Persistent registry is required for hosted Provider Studio publishing. Configure DATABASE_URL instead of storing provider services in runtime memory.");
    error.statusCode = 503;
    error.code = "PERSISTENT_REGISTRY_REQUIRED";
    throw error;
  }
  if ((persistentRegistryRequired() || persistenceEnabled()) && requiresSecret && !providerSecretPassphraseConfigured()) {
    const error = new Error("ADN_PROVIDER_SECRET_PASSPHRASE is required to persist provider credentials. It is a platform encryption key, not a provider API key.");
    error.statusCode = 503;
    error.code = "PROVIDER_SECRET_PASSPHRASE_REQUIRED";
    throw error;
  }
}

export async function writePersistentProviderConfig(config) {
  if (!persistenceEnabled()) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query(
    `insert into adn_provider_configs (service_id, config, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (service_id)
     do update set config = excluded.config, updated_at = now()`,
    [config.manifest.service_id, JSON.stringify(config)]
  );
  return true;
}

export async function readPersistentProviderConfig(serviceId) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    "select config from adn_provider_configs where service_id = $1",
    [serviceId]
  );
  return result.rows[0]?.config || null;
}

export async function deletePersistentProviderConfig(serviceId) {
  if (!persistenceEnabled()) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query("delete from adn_provider_configs where service_id = $1", [serviceId]);
  return true;
}

export async function listPersistentProviderConfigs() {
  if (!persistenceEnabled()) return [];
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    "select config from adn_provider_configs order by updated_at asc, service_id asc"
  );
  return result.rows.map((row) => row.config);
}

export async function writePersistentServiceEvent({ eventType, serviceId, requestId, event }) {
  if (!persistenceEnabled()) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query(
    `insert into adn_service_events (event_type, service_id, request_id, event, created_at)
     values ($1, $2, $3, $4::jsonb, coalesce(($4::jsonb->>'created_at')::timestamptz, now()))`,
    [eventType, serviceId || null, requestId || null, JSON.stringify(event)]
  );
  return true;
}

export async function listPersistentServiceEvents({ limit = 10000 } = {}) {
  if (!persistenceEnabled()) return [];
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    `select event_type, service_id, request_id, event, created_at
     from adn_service_events
     order by created_at asc, event_id asc
     limit $1`,
    [Math.max(1, Math.min(100000, Number(limit) || 10000))]
  );
  return result.rows.map((row) => ({
    event_type: row.event_type,
    service_id: row.service_id,
    request_id: row.request_id,
    event: row.event,
    created_at: row.created_at
  }));
}

export async function deletePersistentProviderSecret(secretRef) {
  if (!persistenceEnabled() || !secretRef) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query("delete from adn_provider_secrets where secret_ref = $1", [secretRef]);
  return true;
}

export async function writePersistentProviderSecret(secretRef, encrypted) {
  if (!persistenceEnabled()) return false;
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query(
    `insert into adn_provider_secrets (secret_ref, encrypted, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (secret_ref)
     do update set encrypted = excluded.encrypted, updated_at = now()`,
    [secretRef, JSON.stringify(encrypted)]
  );
  return true;
}

export async function readPersistentProviderSecret(secretRef) {
  if (!persistenceEnabled()) return null;
  const pool = await getPool();
  await ensureSchema(pool);
  const result = await pool.query(
    "select encrypted from adn_provider_secrets where secret_ref = $1",
    [secretRef]
  );
  return result.rows[0]?.encrypted || null;
}

async function getPool() {
  if (!poolPromise) {
    poolPromise = import("pg").then(({ Pool }) => new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
    }));
  }
  return poolPromise;
}

async function ensureSchema(pool) {
  if (schemaReady) return;
  await pool.query(`
    create table if not exists adn_provider_configs (
      service_id text primary key,
      config jsonb not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists adn_provider_secrets (
      secret_ref text primary key,
      encrypted jsonb not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists adn_service_events (
      event_id bigserial primary key,
      event_type text not null,
      service_id text,
      request_id text,
      event jsonb not null,
      created_at timestamptz not null default now()
    );
    create index if not exists adn_service_events_service_idx on adn_service_events(service_id);
    create index if not exists adn_service_events_type_idx on adn_service_events(event_type);
    create index if not exists adn_service_events_request_idx on adn_service_events(request_id);
  `);
  schemaReady = true;
}
