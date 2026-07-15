#!/bin/bash

set -euo pipefail

readonly METADATA_BASE_URL="http://metadata.google.internal/computeMetadata/v1"
readonly METADATA_HEADER="Metadata-Flavor: Google"
readonly CONTAINER_NAME="pufu-lens-postgres"
readonly POSTGRES_PORT="5432"

metadata_get() {
  curl --fail --silent --show-error \
    --retry 10 \
    --retry-delay 2 \
    --header "$METADATA_HEADER" \
    "${METADATA_BASE_URL}/$1"
}

PROJECT_ID=$(metadata_get "project/project-id")
POSTGRES_IMAGE=$(metadata_get "instance/attributes/postgres-image")
POSTGRES_PASSWORD_SECRET=$(metadata_get "instance/attributes/postgres-password-secret")
POSTGRES_DATA_DISK=$(metadata_get "instance/attributes/postgres-data-disk" 2>/dev/null || true)
POSTGRES_DATA_DISK=${POSTGRES_DATA_DISK:-pg-ai-data}

if [[ -z "$PROJECT_ID" || -z "$POSTGRES_IMAGE" || -z "$POSTGRES_PASSWORD_SECRET" ]]; then
  echo "Required PostgreSQL startup metadata is missing." >&2
  exit 1
fi

if [[ ! "$POSTGRES_PASSWORD_SECRET" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "The PostgreSQL password secret name is invalid." >&2
  exit 1
fi

if [[ ! "$POSTGRES_DATA_DISK" =~ ^[a-z0-9-]+$ ]]; then
  echo "The PostgreSQL data disk device name is invalid." >&2
  exit 1
fi

readonly DATA_DEVICE="/dev/disk/by-id/google-${POSTGRES_DATA_DISK}"
readonly DATA_MOUNT_POINT="/mnt/disks/${POSTGRES_DATA_DISK}"

for _ in $(seq 1 60); do
  [[ -b "$DATA_DEVICE" ]] && break
  sleep 1
done

if [[ ! -b "$DATA_DEVICE" ]]; then
  echo "PostgreSQL data disk did not become available." >&2
  exit 1
fi

FILESYSTEM_TYPE=$(blkid -s TYPE -o value "$DATA_DEVICE" 2>/dev/null || true)
if [[ -z "$FILESYSTEM_TYPE" ]]; then
  mkfs.ext4 -m 0 -F "$DATA_DEVICE"
elif [[ "$FILESYSTEM_TYPE" != "ext4" ]]; then
  echo "PostgreSQL data disk must use EXT4; found ${FILESYSTEM_TYPE}." >&2
  exit 1
fi

mkdir -p "$DATA_MOUNT_POINT"
if ! mountpoint --quiet "$DATA_MOUNT_POINT"; then
  mount -o discard,defaults "$DATA_DEVICE" "$DATA_MOUNT_POINT"
fi

if ! iptables -C INPUT -p tcp --dport "$POSTGRES_PORT" -j ACCEPT 2>/dev/null; then
  iptables -A INPUT -p tcp --dport "$POSTGRES_PORT" -j ACCEPT
fi

TOKEN_RESPONSE=$(metadata_get "instance/service-accounts/default/token")
ACCESS_TOKEN=$(printf '%s' "$TOKEN_RESPONSE" |
  sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
unset TOKEN_RESPONSE

if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "Could not obtain the PostgreSQL VM service account token." >&2
  exit 1
fi

SECRET_RESPONSE=$(curl --fail --silent --show-error \
  --retry 10 \
  --retry-delay 2 \
  --header "Authorization: Bearer ${ACCESS_TOKEN}" \
  "https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${POSTGRES_PASSWORD_SECRET}/versions/latest:access")
unset ACCESS_TOKEN

ENCODED_PASSWORD=$(printf '%s' "$SECRET_RESPONSE" |
  tr '{},' '\n' |
  sed -n 's/^[[:space:]]*"data"[[:space:]]*:[[:space:]]*"\([^"]*\)"[[:space:]]*$/\1/p')
unset SECRET_RESPONSE

if [[ -z "$ENCODED_PASSWORD" ]]; then
  echo "The PostgreSQL password secret payload is empty." >&2
  exit 1
fi

POSTGRES_PASSWORD=$(printf '%s' "$ENCODED_PASSWORD" | base64 --decode)
unset ENCODED_PASSWORD

if [[ -z "$POSTGRES_PASSWORD" ]]; then
  echo "The decoded PostgreSQL password is empty." >&2
  exit 1
fi

readonly SECRET_DIRECTORY="/run/pufu-lens"
readonly PASSWORD_FILE="${SECRET_DIRECTORY}/postgres_password"
mkdir -p "$SECRET_DIRECTORY"
chmod 0700 "$SECRET_DIRECTORY"
umask 077
printf '%s' "$POSTGRES_PASSWORD" >"$PASSWORD_FILE"
unset POSTGRES_PASSWORD
chmod 0600 "$PASSWORD_FILE"

REGISTRY_HOST=${POSTGRES_IMAGE%%/*}
if [[ -z "$REGISTRY_HOST" || "$REGISTRY_HOST" == "$POSTGRES_IMAGE" ]]; then
  echo "The PostgreSQL container image URI is invalid." >&2
  exit 1
fi

export HOME="/home/postgres-startup"
mkdir -p "$HOME/.docker"
chmod 0700 "$HOME" "$HOME/.docker"
docker-credential-gcr configure-docker --registries="$REGISTRY_HOST"
docker pull "$POSTGRES_IMAGE"

if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  docker rm --force "$CONTAINER_NAME"
fi

docker run \
  --detach \
  --name "$CONTAINER_NAME" \
  --network host \
  --restart always \
  --mount "type=bind,source=${DATA_MOUNT_POINT},target=/var/lib/postgresql/data" \
  --mount "type=bind,source=${SECRET_DIRECTORY},target=/run/secrets,readonly" \
  --env POSTGRES_USER=pufu \
  --env POSTGRES_DB=pufu_lens \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
  --env PGDATA=/var/lib/postgresql/data/pgdata \
  "$POSTGRES_IMAGE"

echo "PostgreSQL container started successfully."
