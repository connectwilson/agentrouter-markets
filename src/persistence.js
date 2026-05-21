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
  `);
  schemaReady = true;
}
