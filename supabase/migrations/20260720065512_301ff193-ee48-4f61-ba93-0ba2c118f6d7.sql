
-- Add matching_footage status to projects
ALTER TABLE public.projects DROP CONSTRAINT projects_status_check;
ALTER TABLE public.projects ADD CONSTRAINT projects_status_check CHECK (status = ANY (ARRAY['draft','uploading','uploaded','transcribing','generating_scenes','matching_footage','ready','failed']));

-- Add aspect ratio (drives orientation used for stock search)
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS aspect_ratio TEXT NOT NULL DEFAULT 'landscape' CHECK (aspect_ratio IN ('landscape','portrait','square'));

-- Stock search response cache (server-only, admin writes; no user access)
CREATE TABLE public.stock_search_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider TEXT NOT NULL,
  query TEXT NOT NULL,
  orientation TEXT NOT NULL,
  results JSONB NOT NULL,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, query, orientation)
);
CREATE INDEX idx_stock_search_cache_lookup ON public.stock_search_cache (provider, query, orientation, cached_at DESC);

GRANT ALL ON public.stock_search_cache TO service_role;
ALTER TABLE public.stock_search_cache ENABLE ROW LEVEL SECURITY;
-- No policies for authenticated/anon: table is only touched via supabaseAdmin.
