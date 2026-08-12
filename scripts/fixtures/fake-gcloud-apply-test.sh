#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_GCLOUD_LOG_PATH}"
if [[ "$1" == "logging" && "$2" == "metrics" && "$3" == "list" ]]; then
  if [[ "${GCLOUD_METRIC_LIST_MODE:-}" == "fail" ]]; then
    echo "metric lookup failed" >&2
    exit 1
  fi
  metric_name=""
  for arg in "$@"; do
    if [[ "${arg}" == --filter=name=* ]]; then
      metric_name="${arg#--filter=name=}"
    fi
  done
  if [[ "${GCLOUD_METRIC_LIST_MODE:-}" == "duplicate" ]]; then
    printf '%s\n' "${metric_name}"
    printf '%s\n' "${metric_name}-dup"
    exit 0
  fi
  if [[ "${GCLOUD_METRIC_LIST_MODE:-}" == "mismatch" ]]; then
    printf '%s\n' "wrong-metric-id"
    exit 0
  fi
  if [[ "${GCLOUD_EXISTING_METRICS:-}" == "all" || ",${GCLOUD_EXISTING_METRICS:-}," == *",${metric_name},"* ]]; then
    printf '%s\n' "${metric_name}"
  fi
  exit 0
fi
if [[ "$1" == "monitoring" && "$2" == "policies" && "$3" == "list" ]]; then
  if [[ "${GCLOUD_POLICY_LIST_MODE:-}" == "fail" ]]; then
    echo "policy lookup failed" >&2
    exit 1
  fi
  if [[ "${GCLOUD_POLICY_LIST_RESULT:-}" == "duplicate" ]]; then
    printf '%s\n' "projects/test-project/alertPolicies/one"
    printf '%s\n' "projects/test-project/alertPolicies/two"
    exit 0
  fi
  if [[ -n "${GCLOUD_POLICY_LIST_RESULT:-}" ]]; then
    printf '%s\n' "${GCLOUD_POLICY_LIST_RESULT}"
  fi
fi
if [[ "$1" == "monitoring" && "$2" == "policies" && ( "$3" == "create" || "$3" == "update" ) ]]; then
  policy_file=""
  for arg in "$@"; do
    if [[ "${arg}" == --policy-from-file=* ]]; then
      policy_file="${arg#--policy-from-file=}"
    fi
  done
  if [[ -n "${policy_file}" && -f "${policy_file}" && -n "${FAKE_GCLOUD_POLICY_CAPTURE_DIR:-}" ]]; then
    mkdir -p "${FAKE_GCLOUD_POLICY_CAPTURE_DIR}"
    cp "${policy_file}" "${FAKE_GCLOUD_POLICY_CAPTURE_DIR}/$(basename "${policy_file}")"
  fi
fi
exit 0
