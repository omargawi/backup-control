#!/usr/bin/env bash
set -Eeuo pipefail

: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"

if [[ ! "$BACKUP_AGE_RECIPIENT" =~ ^age1[0-9a-z]+$ ]]; then
  echo 'BACKUP_AGE_RECIPIENT must be an age X25519 public recipient.' >&2
  exit 1
fi

command -v age >/dev/null
command -v jq >/dev/null

mode="${BACKUP_MODE:-production}"
if [[ "$mode" != production && "$mode" != synthetic ]]; then
  echo 'BACKUP_MODE must be production or synthetic.' >&2
  exit 1
fi

validate_schema_list() {
  local value="$1"
  [[ "$value" =~ ^[a-z_][a-z0-9_]*(,[a-z_][a-z0-9_]*)*$ ]]
}

umask 077
backup_tmp="$(mktemp -d "${RUNNER_TEMP:-/tmp}/logical-backup.XXXXXX")"
cleanup() {
  if [[ -n "${backup_tmp:-}" && -d "$backup_tmp" ]]; then
    rm -rf -- "$backup_tmp"
  fi
}
trap cleanup EXIT

output_dir="${BACKUP_OUTPUT_DIR:-backup-artifacts}"
mkdir -p "$output_dir"
chmod 700 "$output_dir"

created_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
source_ref="${GITHUB_SHA:-synthetic}"

if [[ "$mode" == production ]]; then
  : "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required in production mode}"
  : "${BACKUP_SCHEMA_AND_DATA:?BACKUP_SCHEMA_AND_DATA is required in production mode}"
  : "${BACKUP_SCHEMA_ONLY:?BACKUP_SCHEMA_ONLY is required in production mode}"

  if [[ ! "$BACKUP_DATABASE_URL" =~ ^postgres(ql)?:// ]]; then
    echo 'BACKUP_DATABASE_URL must use the postgres or postgresql scheme.' >&2
    exit 1
  fi
  validate_schema_list "$BACKUP_SCHEMA_AND_DATA" || {
    echo 'BACKUP_SCHEMA_AND_DATA is not a safe schema list.' >&2
    exit 1
  }
  validate_schema_list "$BACKUP_SCHEMA_ONLY" || {
    echo 'BACKUP_SCHEMA_ONLY is not a safe schema list.' >&2
    exit 1
  }
  : "${BACKUP_PGDUMP_IMAGE:?A digest-pinned PostgreSQL 17 image is required}"
  command -v docker >/dev/null

  readiness_query="
    select case when
      (select ssl from pg_stat_ssl where pid = pg_backend_pid())
      and not exists (
        select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
          and (not c.relrowsecurity or not exists (
            select 1 from pg_policy p
            where p.polrelid = c.oid
              and p.polname = 'backup_reader_select'
              and p.polpermissive and p.polcmd in ('r', '*')
              and p.polroles @> array[current_user::regrole::oid]
          ))
      )
    then 'ready' else 'unsafe' end"
  readiness="$(docker run --rm --network host --read-only --user "$(id -u):$(id -g)" \
    --env BACKUP_DATABASE_URL --env PGSSLMODE=require \
    --entrypoint /bin/sh "$BACKUP_PGDUMP_IMAGE" -ceu \
    'psql "$BACKUP_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "$1"' sh "$readiness_query")"
  if [[ "$readiness" != ready ]]; then
    echo 'Backup requires TLS and a scoped SELECT policy on every public table.' >&2
    exit 1
  fi

  dump() {
    local output="$1"
    docker run --rm --network host --read-only --user "$(id -u):$(id -g)" \
      --mount "type=bind,source=$backup_tmp,target=/backup" \
      --env BACKUP_DATABASE_URL --env BACKUP_SCHEMA_AND_DATA \
      --env BACKUP_SCHEMA_ONLY --env PGSSLMODE=require \
      --entrypoint /bin/sh "$BACKUP_PGDUMP_IMAGE" -ceu '
        output="$1"
        if [ "$output" = schema.sql ]; then
          schemas="$BACKUP_SCHEMA_AND_DATA,$BACKUP_SCHEMA_ONLY"
        else
          schemas="$BACKUP_SCHEMA_AND_DATA"
        fi
        set --
        for schema in $(printf "%s" "$schemas" | tr "," " "); do
          set -- "$@" --schema="$schema"
        done
        if [ "$output" = schema.sql ]; then
          pg_dump --dbname="$BACKUP_DATABASE_URL" --no-owner --no-privileges \
            --schema-only --file=/backup/schema.sql "$@"
        else
          pg_dump --dbname="$BACKUP_DATABASE_URL" --no-owner --no-privileges \
            --data-only --enable-row-security --inserts \
            --file=/backup/data.sql "$@"
        fi
      ' sh "$output"
  }

  # The reader is deliberately NOBYPASSRLS. A dedicated SELECT policy for
  # its role covers every declared application table. Row security must stay
  # enabled in pg_dump; the default would fail rather than silently omit rows.
  dump schema.sql
  dump data.sql
  tool_version="$(docker run --rm --entrypoint pg_dump "$BACKUP_PGDUMP_IMAGE" --version)"
else
  printf '%s\n' 'CREATE TABLE public.synthetic_backup_probe (id integer);' > "$backup_tmp/schema.sql"
  printf '%s\n' 'COPY public.synthetic_backup_probe (id) FROM stdin;' '1' '\\.' > "$backup_tmp/data.sql"
  BACKUP_SCHEMA_AND_DATA=public
  BACKUP_SCHEMA_ONLY=private
  tool_version=synthetic
fi

jq -n \
  --arg created_at "$created_at" \
  --arg source_ref "$source_ref" \
  --arg mode "$mode" \
  --arg tool_version "$tool_version" \
  --arg schema_and_data "$BACKUP_SCHEMA_AND_DATA" \
  --arg schema_only "$BACKUP_SCHEMA_ONLY" \
  '{
    format_version: 1,
    created_at: $created_at,
    source_ref: $source_ref,
    mode: $mode,
    dump_tool: $tool_version,
    schema_and_data: ($schema_and_data | split(",")),
    schema_only: ($schema_only | split(","))
  }' > "$backup_tmp/manifest.json"

(
  cd "$backup_tmp"
  sha256sum data.sql manifest.json schema.sql > SHA256SUMS
  sha256sum --check --strict SHA256SUMS
)

archive="$backup_tmp/logical-backup-${timestamp}.tar.gz"
tar -C "$backup_tmp" \
  --sort=name \
  --mtime='UTC 1970-01-01' \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -czf "$archive" \
  SHA256SUMS data.sql manifest.json schema.sql

provisional="$backup_tmp/logical-backup-${timestamp}.tar.gz.age"
age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$provisional" "$archive"
encrypted_sha256="$(sha256sum "$provisional" | awk '{print $1}')"
encrypted_path="$output_dir/logical-backup-${timestamp}-${encrypted_sha256}.tar.gz.age"
mv "$provisional" "$encrypted_path"

if [[ "$(head -c 21 "$encrypted_path")" != 'age-encryption.org/v1' ]]; then
  echo 'Encrypted artifact does not have an age v1 header.' >&2
  exit 1
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "encrypted_path=$encrypted_path"
    echo "encrypted_sha256=$encrypted_sha256"
  } >> "$GITHUB_OUTPUT"
fi

echo "Created ciphertext: $encrypted_path"
