
create extension if not exists pgcrypto;

-- 1. users profile
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  plan_tier text not null default 'free' check (plan_tier in ('free','pro','business')),
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.users to authenticated;
grant all on public.users to service_role;
alter table public.users enable row level security;
create policy "own profile" on public.users for all using (auth.uid() = id) with check (auth.uid() = id);

-- 2. projects
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null default 'Untitled project',
  status text not null default 'draft' check (status in (
    'draft','uploading','transcribing','generating_scenes',
    'matching_footage','ready','rendering','completed','failed'
  )),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_projects_user_id on public.projects(user_id);
create index idx_projects_status on public.projects(status);
grant select, insert, update, delete on public.projects to authenticated;
grant all on public.projects to service_role;
alter table public.projects enable row level security;
create policy "own projects" on public.projects for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 3. audio_assets
create table public.audio_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  storage_path text not null,
  filename text not null,
  duration_sec numeric,
  file_size_bytes bigint,
  mime_type text,
  created_at timestamptz not null default now()
);
create index idx_audio_assets_project_id on public.audio_assets(project_id);
grant select, insert, update, delete on public.audio_assets to authenticated;
grant all on public.audio_assets to service_role;
alter table public.audio_assets enable row level security;
create policy "own audio_assets" on public.audio_assets for all
  using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

-- 4. transcripts
create table public.transcripts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  audio_asset_id uuid references public.audio_assets(id) on delete set null,
  provider text not null check (provider in ('assemblyai','groq_whisper','deepgram','openai_whisper')),
  full_text text not null,
  word_timestamps jsonb,
  language text default 'en',
  created_at timestamptz not null default now()
);
create index idx_transcripts_project_id on public.transcripts(project_id);
grant select, insert, update, delete on public.transcripts to authenticated;
grant all on public.transcripts to service_role;
alter table public.transcripts enable row level security;
create policy "own transcripts" on public.transcripts for all
  using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

-- 5. scenes
create table public.scenes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  transcript_id uuid not null references public.transcripts(id) on delete cascade,
  idx integer not null,
  start_ts numeric not null,
  end_ts numeric not null,
  text text not null,
  visual_query text,
  status text not null default 'pending' check (status in (
    'pending','query_ready','matched','selected','failed'
  )),
  created_at timestamptz not null default now(),
  unique (project_id, idx)
);
create index idx_scenes_project_id on public.scenes(project_id);
create index idx_scenes_status on public.scenes(status);
grant select, insert, update, delete on public.scenes to authenticated;
grant all on public.scenes to service_role;
alter table public.scenes enable row level security;
create policy "own scenes" on public.scenes for all
  using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

-- 6. clip_candidates
create table public.clip_candidates (
  id uuid primary key default gen_random_uuid(),
  scene_id uuid not null references public.scenes(id) on delete cascade,
  provider text not null check (provider in ('pexels','pixabay')),
  provider_clip_id text not null,
  url text not null,
  thumbnail_url text,
  width integer,
  height integer,
  duration_sec numeric,
  score numeric,
  created_at timestamptz not null default now()
);
create index idx_clip_candidates_scene_id on public.clip_candidates(scene_id);
create index idx_clip_candidates_provider_clip on public.clip_candidates(provider, provider_clip_id);
grant select, insert, update, delete on public.clip_candidates to authenticated;
grant all on public.clip_candidates to service_role;
alter table public.clip_candidates enable row level security;
create policy "own clip_candidates" on public.clip_candidates for all
  using (scene_id in (
    select s.id from public.scenes s
    join public.projects p on p.id = s.project_id
    where p.user_id = auth.uid()
  ))
  with check (scene_id in (
    select s.id from public.scenes s
    join public.projects p on p.id = s.project_id
    where p.user_id = auth.uid()
  ));

-- 7. selected_clips
create table public.selected_clips (
  id uuid primary key default gen_random_uuid(),
  scene_id uuid not null references public.scenes(id) on delete cascade,
  clip_candidate_id uuid not null references public.clip_candidates(id) on delete cascade,
  in_point numeric not null default 0,
  out_point numeric not null,
  created_at timestamptz not null default now(),
  unique (scene_id)
);
create index idx_selected_clips_scene_id on public.selected_clips(scene_id);
grant select, insert, update, delete on public.selected_clips to authenticated;
grant all on public.selected_clips to service_role;
alter table public.selected_clips enable row level security;
create policy "own selected_clips" on public.selected_clips for all
  using (scene_id in (
    select s.id from public.scenes s
    join public.projects p on p.id = s.project_id
    where p.user_id = auth.uid()
  ))
  with check (scene_id in (
    select s.id from public.scenes s
    join public.projects p on p.id = s.project_id
    where p.user_id = auth.uid()
  ));

-- 8. render_jobs
create table public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  status text not null default 'queued' check (status in (
    'queued','downloading','rendering','completed','failed'
  )),
  progress_pct integer not null default 0 check (progress_pct between 0 and 100),
  settings jsonb not null,
  output_url text,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_render_jobs_project_id on public.render_jobs(project_id);
create index idx_render_jobs_status on public.render_jobs(status);
grant select, insert, update, delete on public.render_jobs to authenticated;
grant all on public.render_jobs to service_role;
alter table public.render_jobs enable row level security;
create policy "own render_jobs" on public.render_jobs for all
  using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

-- 9. provider_usage (service-role only, no user policy)
create table public.provider_usage (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('pexels','pixabay','assemblyai','groq_whisper','deepgram')),
  usage_date date not null default current_date,
  request_count integer not null default 0,
  cache_hit_count integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (provider, usage_date)
);
grant all on public.provider_usage to service_role;
alter table public.provider_usage enable row level security;

-- Auto-create profile row when auth.users row is inserted
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_projects_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

create trigger trg_render_jobs_updated_at
  before update on public.render_jobs
  for each row execute function public.set_updated_at();

-- Storage RLS: users can access objects in the 'audio' bucket only when
-- the first path segment is a project id they own.
create policy "audio: own project read" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'audio'
    and (storage.foldername(name))[1] in (
      select id::text from public.projects where user_id = auth.uid()
    )
  );

create policy "audio: own project insert" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'audio'
    and (storage.foldername(name))[1] in (
      select id::text from public.projects where user_id = auth.uid()
    )
  );

create policy "audio: own project update" on storage.objects for update
  to authenticated
  using (
    bucket_id = 'audio'
    and (storage.foldername(name))[1] in (
      select id::text from public.projects where user_id = auth.uid()
    )
  );

create policy "audio: own project delete" on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'audio'
    and (storage.foldername(name))[1] in (
      select id::text from public.projects where user_id = auth.uid()
    )
  );
