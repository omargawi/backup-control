# Operations

## Protected environment

Create a GitHub environment named `production-backup`, restrict deployment to
the protected `main` branch, and configure:

| Name | Kind | Purpose |
| --- | --- | --- |
| `BLOB_READ_WRITE_TOKEN` | environment secret | Dedicated private Vercel Blob store |
| `BACKUP_DATABASE_URL` | environment secret | Read-only, TLS-required PostgreSQL login |
| `BACKUP_AGE_RECIPIENT` | environment variable | Public `age1...` recipient only |
| `BACKUP_SCHEMA_AND_DATA` | environment variable | Comma-separated application schemas with data |
| `BACKUP_SCHEMA_ONLY` | environment variable | Comma-separated application schemas whose definitions are restorable |
| `BACKUP_NAMESPACE` | environment variable | Non-sensitive lowercase storage namespace |
| `BACKUP_ENABLED` | repository variable | Exact value `true` activates Production jobs |

The database role must be `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE`
with only the schema `USAGE` and table/sequence `SELECT` needed for the declared
scope. Grant matching default privileges for future tables and sequences. It
must have no write, platform-schema, Auth, Storage, or function-execution
privilege. Rotate its independent password through the environment secret.
Keep `NOBYPASSRLS`; add a SELECT policy for this role to every application
table in the declared data scope. The pinned PostgreSQL client dumps only rows
visible to those policies using `--enable-row-security --inserts`. A newly
added table without a matching policy must stop the backup rather than create
an incomplete archive. The connection must negotiate TLS. Include a recent
schema inventory comparison when reviewing a backup.

The private X25519 `age` identity never enters GitHub, Vercel, an application
repository, or an online recovery host. Only its public recipient is configured.

## Activation

1. Leave `BACKUP_ENABLED` absent or false while provisioning and reviewing.
2. Run the manual `synthetic` mode. It must upload, authenticate-download,
   verify, and delete only generated ciphertext.
3. Configure the least-privilege database login and public `age` recipient.
4. Set `BACKUP_ENABLED=true` and run manual `production` mode once.
5. Confirm `Backup` and `Backup freshness` succeed from protected `main`.
6. Perform a recovery drill into an isolated empty database before relying on
   the schedule.

## Recovery

Recovery is an explicit incident operation. Download one private ciphertext
object using an authorized Vercel Blob credential, verify that the SHA-256 in
its pathname matches the downloaded ciphertext, and transfer it to the offline
recovery device. Decrypt there with the owner-held identity. Verify `SHA256SUMS`
inside the archive before inspecting or restoring SQL.

Restore only into an isolated empty database first, using a single transaction
and stop-on-error semantics. Reconcile platform-managed identity separately;
never restore managed Auth/session tables from this logical application backup.
Provision the backup role name without its login credential in the disposable
environment before restoring schema policies. Restore as an authorized local
database owner, then validate table coverage, row counts, commands and RLS.
Production restoration requires its own authorization.

## Failure handling

Any unrecognized pathname under the configured namespace, oversized backup,
whole-store capacity risk, stale latest backup, metadata mismatch, authenticated
download mismatch, or dependency/install integrity failure stops the job.
Pruning targets only recognized ciphertext paths and preserves at least two
verified Production backups. Synthetic paths are unique and deleted by the same
run after verification.
