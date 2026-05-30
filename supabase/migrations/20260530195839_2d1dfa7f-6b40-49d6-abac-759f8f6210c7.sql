
-- Enums
do $$ begin
  create type job_state as enum ('pending','queued','processing','completed','failed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type user_role as enum ('user','admin');
exception when duplicate_object then null; end $$;

-- users
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role user_role not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- portal_configs
create table if not exists public.portal_configs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_url text not null,
  selectors jsonb not null default '{}'::jsonb,
  login_config jsonb,
  timeout_ms integer not null default 180000,
  poll_interval_ms integer not null default 5000,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- jobs
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  portal_id uuid references public.portal_configs(id) on delete set null,
  status job_state not null default 'pending',
  original_name text not null,
  source_path text not null,
  mime_type text,
  size_bytes bigint,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  error text,
  bull_job_id text,
  queued_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jobs_user_idx on public.jobs(user_id);
create index if not exists jobs_status_idx on public.jobs(status);
create index if not exists jobs_created_idx on public.jobs(created_at desc);

-- reports
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);
create index if not exists reports_job_idx on public.reports(job_id);

-- audit_logs
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.users(id) on delete set null,
  action text not null,
  entity text,
  entity_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_actor_idx on public.audit_logs(actor_id);

-- worker_logs
create table if not exists public.worker_logs (
  id uuid primary key default gen_random_uuid(),
  worker_id text not null,
  level text not null default 'info',
  message text not null,
  job_id uuid references public.jobs(id) on delete set null,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists worker_logs_worker_idx on public.worker_logs(worker_id);
create index if not exists worker_logs_created_idx on public.worker_logs(created_at desc);

-- worker_health
create table if not exists public.worker_health (
  worker_id text primary key,
  last_seen timestamptz not null default now(),
  active_jobs integer not null default 0,
  status text not null default 'online'
);

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$ begin
  create trigger trg_users_updated before update on public.users
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger trg_jobs_updated before update on public.jobs
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger trg_portal_updated before update on public.portal_configs
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

-- New auth user → public.users
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name',''))
  on conflict (id) do nothing;
  return new;
end $$;

do $$ begin
  create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();
exception when duplicate_object then null; end $$;

-- is_admin helper
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.users where id = auth.uid() and role = 'admin');
$$;

-- Grants
grant select, insert, update, delete on public.users to authenticated;
grant select, insert, update, delete on public.jobs to authenticated;
grant select, insert, update, delete on public.reports to authenticated;
grant select, insert, update, delete on public.portal_configs to authenticated;
grant select on public.audit_logs to authenticated;
grant select on public.worker_logs to authenticated;
grant select on public.worker_health to authenticated;
grant all on public.users, public.jobs, public.reports, public.portal_configs,
  public.audit_logs, public.worker_logs, public.worker_health to service_role;

-- RLS
alter table public.users enable row level security;
alter table public.jobs enable row level security;
alter table public.reports enable row level security;
alter table public.portal_configs enable row level security;
alter table public.audit_logs enable row level security;
alter table public.worker_logs enable row level security;
alter table public.worker_health enable row level security;

drop policy if exists users_self_select on public.users;
create policy users_self_select on public.users for select to authenticated
  using (id = auth.uid() or public.is_admin());
drop policy if exists users_self_update on public.users;
create policy users_self_update on public.users for update to authenticated
  using (id = auth.uid());

drop policy if exists jobs_owner_all on public.jobs;
create policy jobs_owner_all on public.jobs for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists reports_owner_select on public.reports;
create policy reports_owner_select on public.reports for select to authenticated
  using (public.is_admin() or exists(
    select 1 from public.jobs j where j.id = reports.job_id and j.user_id = auth.uid()));

drop policy if exists portal_read on public.portal_configs;
create policy portal_read on public.portal_configs for select to authenticated using (true);
drop policy if exists portal_admin_write on public.portal_configs;
create policy portal_admin_write on public.portal_configs for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists audit_admin_read on public.audit_logs;
create policy audit_admin_read on public.audit_logs for select to authenticated
  using (public.is_admin());

drop policy if exists worker_logs_admin_read on public.worker_logs;
create policy worker_logs_admin_read on public.worker_logs for select to authenticated
  using (public.is_admin());

drop policy if exists worker_health_admin_read on public.worker_health;
create policy worker_health_admin_read on public.worker_health for select to authenticated
  using (public.is_admin());

-- Storage buckets
insert into storage.buckets (id, name, public) values ('documents','documents', false)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('reports','reports', false)
  on conflict (id) do nothing;

-- documents: owner-only access by folder = user id; admins all
drop policy if exists documents_owner_select on storage.objects;
create policy documents_owner_select on storage.objects for select to authenticated
  using (bucket_id = 'documents' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
drop policy if exists documents_owner_insert on storage.objects;
create policy documents_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists documents_owner_update on storage.objects;
create policy documents_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'documents' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
drop policy if exists documents_owner_delete on storage.objects;
create policy documents_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- reports: read for owner / admin (worker writes via service role)
drop policy if exists reports_owner_select_obj on storage.objects;
create policy reports_owner_select_obj on storage.objects for select to authenticated
  using (bucket_id = 'reports' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
