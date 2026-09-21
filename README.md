# Encrypted logical backup control

A minimal, application-agnostic controller for scheduled PostgreSQL logical
backups. It creates a scoped logical dump, validates the payload, encrypts it
with an offline-held `age` recovery identity, and stores ciphertext in a
private Vercel Blob store.

The repository intentionally contains no application source, schema, data,
credentials, recovery identity, or uploaded backup. Production execution is
disabled until the protected `production-backup` environment is configured and
`BACKUP_ENABLED` is set to `true`.

Security properties:

- every external action and downloaded tool is pinned by immutable digest;
- the workflow has read-only repository permission and runs only from `main`;
- plaintext exists only in a private runner temporary directory and is removed
  on exit;
- only `age` ciphertext is uploaded, with an authenticated download and SHA-256
  verification before success;
- seven verified backups are retained;
- a 50 MB per-backup limit and 400 MB whole-store limit fail closed well below
  the Vercel Blob Hobby allowance;
- freshness is checked independently every six hours;
- synthetic verification uses generated non-sensitive data and a one-run
  ephemeral recovery identity, then deletes its ciphertext.

See [OPERATIONS.md](OPERATIONS.md) for the generic configuration and recovery
contract.

