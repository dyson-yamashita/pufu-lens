-- Migration: 0023_activitypub_validate_inbound_report_constraints
-- Purpose: Validate ActivityPub Step 5 inbound federated report CHECK constraints after NOT VALID add.

ALTER TABLE public.federated_reports
  VALIDATE CONSTRAINT federated_reports_remote_object_uri_https_check;

ALTER TABLE public.federated_reports
  VALIDATE CONSTRAINT federated_reports_remote_activity_uri_https_check;

ALTER TABLE public.federated_reports
  VALIDATE CONSTRAINT federated_reports_remote_actor_uri_https_check;

ALTER TABLE public.federated_reports
  VALIDATE CONSTRAINT federated_reports_original_url_https_check;

ALTER TABLE public.federated_reports
  VALIDATE CONSTRAINT federated_reports_title_length_check;

ALTER TABLE public.federated_reports
  VALIDATE CONSTRAINT federated_reports_summary_length_check;

ALTER TABLE public.federated_reports
  VALIDATE CONSTRAINT federated_reports_uri_length_check;
