#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ID=""
APPLY=false
NOTIFICATION_CHANNELS=()

PROJECT_ID_PATTERN='^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
CHANNEL_PATTERN='^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/notificationChannels/[A-Za-z0-9._-]+$'

usage() {
  cat <<'EOF'
Usage: apply.sh --project PROJECT_ID [--notification-channel CHANNEL]... [--apply]

Validates ActivityPub observability log metrics and alert policies.
Without --apply, prints a conditional plan and performs no gcloud mutations.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      if [[ $# -lt 2 || -z "${2:-}" || "${2:-}" == --* ]]; then
        echo "error: --project requires a non-empty value" >&2
        exit 1
      fi
      PROJECT_ID="$2"
      shift 2
      ;;
    --notification-channel)
      if [[ $# -lt 2 || -z "${2:-}" || "${2:-}" == --* ]]; then
        echo "error: --notification-channel requires a non-empty value" >&2
        exit 1
      fi
      NOTIFICATION_CHANNELS+=("$2")
      shift 2
      ;;
    --apply)
      APPLY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${PROJECT_ID}" ]]; then
  echo "error: --project is required" >&2
  exit 1
fi

if ! [[ "${PROJECT_ID}" =~ ${PROJECT_ID_PATTERN} ]]; then
  echo "error: invalid --project value" >&2
  exit 1
fi

for channel in "${NOTIFICATION_CHANNELS[@]}"; do
  if ! [[ "${channel}" =~ ${CHANNEL_PATTERN} ]]; then
    echo "error: invalid --notification-channel value" >&2
    exit 1
  fi
done

METRIC_FILES=("${ROOT_DIR}"/log-metrics/*.json)
POLICY_FILES=("${ROOT_DIR}"/alert-policies/*.json)

if [[ ${#METRIC_FILES[@]} -eq 0 || ! -e "${METRIC_FILES[0]}" ]]; then
  echo "error: no log metric definitions found" >&2
  exit 1
fi

if [[ ${#POLICY_FILES[@]} -eq 0 || ! -e "${POLICY_FILES[0]}" ]]; then
  echo "error: no alert policy definitions found" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

validate_json() {
  local file="$1"
  python3 - "$file" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    json.load(handle)
PY
}

validate_safe_metric_or_policy() {
  local file="$1"
  python3 - "$file" <<'PY'
import json
import re
import sys

path = sys.argv[1]
sensitive = re.compile(
    r"message_json|payload_json|private_key|DATABASE_URL|response_body|responseHeaders",
    re.IGNORECASE,
)
with open(path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

def walk(value):
    if isinstance(value, dict):
        for key, nested in value.items():
            if key in {"filter", "valueExtractor", "labelExtractors"}:
                serialized = json.dumps(nested)
                if sensitive.search(serialized):
                    raise SystemExit(f"sensitive field reference found in {path}::{key}")
            walk(nested)
    elif isinstance(value, list):
        for nested in value:
            walk(nested)

walk(payload)
PY
}

for file in "${METRIC_FILES[@]}" "${POLICY_FILES[@]}"; do
  validate_json "${file}"
  validate_safe_metric_or_policy "${file}"
done

render_policy_file() {
  local source_file="$1"
  local rendered_file="$2"
  python3 - "$source_file" "$rendered_file" "${NOTIFICATION_CHANNELS[@]}" <<'PY'
import json
import sys

source_path, rendered_path = sys.argv[1], sys.argv[2]
channels = sys.argv[3:]
with open(source_path, "r", encoding="utf-8") as handle:
    policy = json.load(handle)
if channels:
    policy["notificationChannels"] = channels
with open(rendered_path, "w", encoding="utf-8") as handle:
    json.dump(policy, handle)
PY
}

read_alert_key() {
  local file="$1"
  python3 - "$file" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    policy = json.load(handle)
print(policy["userLabels"]["pufu_lens_alert"])
PY
}

plan_metric() {
  local file="$1"
  local metric_name
  metric_name="$(basename "${file}" .json)"
  echo "metric ${metric_name}: describe exact name; fail closed on lookup failure; update one match; create on zero matches"
}

plan_policy() {
  local file="$1"
  local alert_key
  alert_key="$(read_alert_key "${file}")"
  echo "policy ${alert_key}: list by userLabels.pufu_lens_alert=${alert_key}; if one match then update positional policy name, elif zero then create, else fail closed"
}

echo "ActivityPub observability plan for project ${PROJECT_ID}"
for file in "${METRIC_FILES[@]}"; do
  plan_metric "${file}"
done
for file in "${POLICY_FILES[@]}"; do
  plan_policy "${file}"
done

if [[ "${APPLY}" != true ]]; then
  echo "Dry run only. Re-run with --apply to execute gcloud mutations."
  exit 0
fi

LOOKUP_RESULT=""

lookup_logging_metric_names() {
  local metric_name="$1"
  local list_file="${WORK_DIR}/metric-list-${metric_name}.txt"
  local err_file="${WORK_DIR}/metric-list-${metric_name}.err"
  LOOKUP_RESULT=""

  if ! gcloud logging metrics list \
    --project="${PROJECT_ID}" \
    --filter="name=${metric_name}" \
    --format="value(name)" >"${list_file}" 2>"${err_file}"; then
    echo "error: metric lookup failed for ${metric_name}" >&2
    cat "${err_file}" >&2
    exit 1
  fi

  local names=()
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ -n "${line}" ]]; then
      names+=("${line}")
    fi
  done <"${list_file}"

  if [[ ${#names[@]} -gt 1 ]]; then
    echo "error: multiple log metrics found for ${metric_name}" >&2
    exit 1
  fi

  if [[ ${#names[@]} -eq 1 ]]; then
    if [[ "${names[0]}" != "${metric_name}" ]]; then
      echo "error: log metric name mismatch for ${metric_name}" >&2
      exit 1
    fi
    LOOKUP_RESULT="${names[0]}"
    return 0
  fi

  return 1
}

for file in "${METRIC_FILES[@]}"; do
  metric_name="$(basename "${file}" .json)"
  if lookup_logging_metric_names "${metric_name}"; then
    gcloud logging metrics update "${metric_name}" \
      --project="${PROJECT_ID}" \
      --config-from-file="${file}"
  else
    gcloud logging metrics create "${metric_name}" \
      --project="${PROJECT_ID}" \
      --config-from-file="${file}"
  fi
done

lookup_alert_policy_names() {
  local alert_key="$1"
  local list_file="${WORK_DIR}/policy-list-${alert_key}.txt"
  local err_file="${WORK_DIR}/policy-list-${alert_key}.err"
  LOOKUP_RESULT=""

  if ! gcloud monitoring policies list \
    --project="${PROJECT_ID}" \
    --filter="userLabels.pufu_lens_alert=${alert_key}" \
    --format="value(name)" >"${list_file}" 2>"${err_file}"; then
    echo "error: alert policy lookup failed for ${alert_key}" >&2
    cat "${err_file}" >&2
    exit 1
  fi

  local names=()
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ -n "${line}" ]]; then
      names+=("${line}")
    fi
  done <"${list_file}"

  if [[ ${#names[@]} -gt 1 ]]; then
    echo "error: multiple alert policies found for ${alert_key}" >&2
    exit 1
  fi

  if [[ ${#names[@]} -eq 1 ]]; then
    LOOKUP_RESULT="${names[0]}"
    return 0
  fi

  return 1
}

for file in "${POLICY_FILES[@]}"; do
  alert_key="$(read_alert_key "${file}")"
  rendered="${WORK_DIR}/$(basename "${file}")"
  render_policy_file "${file}" "${rendered}"

  if lookup_alert_policy_names "${alert_key}"; then
    gcloud monitoring policies update "${LOOKUP_RESULT}" --policy-from-file="${rendered}"
  else
    gcloud monitoring policies create --project="${PROJECT_ID}" --policy-from-file="${rendered}"
  fi
done

echo "ActivityPub observability resources applied."
