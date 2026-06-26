ALTER TABLE public.actors
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS merged_into_actor_id UUID,
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disabled_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'actors_project_id_id_key'
      AND conrelid = 'public.actors'::regclass
  ) THEN
    ALTER TABLE public.actors
      ADD CONSTRAINT actors_project_id_id_key
      UNIQUE (project_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'actors_status_check'
      AND conrelid = 'public.actors'::regclass
  ) THEN
    ALTER TABLE public.actors
      ADD CONSTRAINT actors_status_check
      CHECK (status IN ('active', 'merged', 'disabled'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'actors_merged_into_not_self_check'
      AND conrelid = 'public.actors'::regclass
  ) THEN
    ALTER TABLE public.actors
      ADD CONSTRAINT actors_merged_into_not_self_check
      CHECK (merged_into_actor_id IS NULL OR merged_into_actor_id <> id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'actors_merged_into_same_project_fk'
      AND conrelid = 'public.actors'::regclass
  ) THEN
    ALTER TABLE public.actors
      ADD CONSTRAINT actors_merged_into_same_project_fk
      FOREIGN KEY (project_id, merged_into_actor_id)
      REFERENCES public.actors (project_id, id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS actors_project_status_idx
  ON public.actors (project_id, status);

CREATE INDEX IF NOT EXISTS actors_project_merged_into_idx
  ON public.actors (project_id, merged_into_actor_id);

CREATE TABLE IF NOT EXISTS public.actor_merge_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  primary_actor_id UUID NOT NULL,
  secondary_actor_id UUID NOT NULL,
  decision_type TEXT NOT NULL CHECK (decision_type IN ('merge', 'reject')),
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (primary_actor_id <> secondary_actor_id),
  CONSTRAINT actor_merge_decisions_primary_same_project_fk
    FOREIGN KEY (project_id, primary_actor_id)
    REFERENCES public.actors (project_id, id),
  CONSTRAINT actor_merge_decisions_secondary_same_project_fk
    FOREIGN KEY (project_id, secondary_actor_id)
    REFERENCES public.actors (project_id, id)
);

CREATE INDEX IF NOT EXISTS actor_merge_decisions_project_primary_idx
  ON public.actor_merge_decisions (project_id, primary_actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS actor_merge_decisions_project_secondary_idx
  ON public.actor_merge_decisions (project_id, secondary_actor_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS actor_merge_decisions_project_pair_type_idx
  ON public.actor_merge_decisions (
    project_id,
    decision_type,
    LEAST(primary_actor_id, secondary_actor_id),
    GREATEST(primary_actor_id, secondary_actor_id)
  );
