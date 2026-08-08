-- pufu-lens: no-transaction
-- Migration: 0018_activitypub_follow_indexes
-- Purpose: ActivityPub Step 3 follow collection indexes (concurrent).

DROP INDEX CONCURRENTLY IF EXISTS public.activitypub_follows_accepted_collection_idx;

-- pufu-lens: statement-break

CREATE INDEX CONCURRENTLY activitypub_follows_accepted_collection_idx
  ON public.activitypub_follows (local_actor_id, direction, created_at, id)
  WHERE status = 'accepted';

-- pufu-lens: statement-break

DROP INDEX CONCURRENTLY IF EXISTS public.activitypub_follows_outbound_project_list_idx;

-- pufu-lens: statement-break

CREATE INDEX CONCURRENTLY activitypub_follows_outbound_project_list_idx
  ON public.activitypub_follows (local_actor_id, created_at, id)
  WHERE direction = 'outbound';
