-- Migration: 0022_activitypub_inbound_reports
-- Purpose: ActivityPub Step 5 inbound federated report constraints, index, and follow binding trigger.

ALTER TABLE public.federated_reports
  ADD CONSTRAINT federated_reports_remote_object_uri_https_check
  CHECK (remote_object_uri ~ '^https://[^[:space:]#]+$') NOT VALID;

ALTER TABLE public.federated_reports
  ADD CONSTRAINT federated_reports_remote_activity_uri_https_check
  CHECK (remote_activity_uri ~ '^https://[^[:space:]#]+$') NOT VALID;

ALTER TABLE public.federated_reports
  ADD CONSTRAINT federated_reports_remote_actor_uri_https_check
  CHECK (remote_actor_uri ~ '^https://[^[:space:]#]+$') NOT VALID;

ALTER TABLE public.federated_reports
  ADD CONSTRAINT federated_reports_original_url_https_check
  CHECK (original_url ~ '^https://[^[:space:]#]+$') NOT VALID;

ALTER TABLE public.federated_reports
  ADD CONSTRAINT federated_reports_title_length_check
  CHECK (char_length(title) > 0 AND char_length(title) <= 300) NOT VALID;

ALTER TABLE public.federated_reports
  ADD CONSTRAINT federated_reports_summary_length_check
  CHECK (octet_length(summary_html_sanitized) <= 16384) NOT VALID;

ALTER TABLE public.federated_reports
  ADD CONSTRAINT federated_reports_uri_length_check
  CHECK (
    char_length(remote_object_uri) <= 2048
    AND char_length(remote_activity_uri) <= 2048
    AND char_length(remote_actor_uri) <= 2048
    AND char_length(original_url) <= 2048
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS federated_reports_project_listing_idx
  ON public.federated_reports (project_id, COALESCE(published_at, received_at) DESC, id DESC);

CREATE OR REPLACE FUNCTION public.activitypub_validate_federated_report_follow()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.project_id IS DISTINCT FROM NEW.project_id
      OR OLD.source_follow_id IS DISTINCT FROM NEW.source_follow_id
      OR OLD.remote_actor_uri IS DISTINCT FROM NEW.remote_actor_uri
    THEN
      RAISE EXCEPTION 'invalid federated report follow binding';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.activitypub_follows f
    INNER JOIN public.activitypub_actors a ON a.id = f.local_actor_id
    WHERE f.id = NEW.source_follow_id
      AND f.direction = 'outbound'
      AND f.status = 'accepted'
      AND f.accepted_at IS NOT NULL
      AND f.undone_at IS NULL
      AND f.remote_actor_uri = NEW.remote_actor_uri
      AND a.project_id = NEW.project_id
      AND a.kind = 'project'
      AND a.enabled = true
  ) THEN
    RAISE EXCEPTION 'invalid federated report follow binding';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS federated_reports_validate_follow ON public.federated_reports;
CREATE TRIGGER federated_reports_validate_follow
  BEFORE INSERT OR UPDATE OF project_id, source_follow_id, remote_actor_uri ON public.federated_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.activitypub_validate_federated_report_follow();
