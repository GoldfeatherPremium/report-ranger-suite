
-- Extensions
create extension if not exists pgcrypto;
create extension if not exists "supabase_vault";

-- Store a symmetric encryption key in vault (auto-generated, one-time)
do $$
declare
  k_id uuid;
begin
  select id into k_id from vault.secrets where name = 'turnitin_enc_key';
  if k_id is null then
    perform vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'turnitin_enc_key', 'Symmetric key for Turnitin account passwords');
  end if;
end $$;

-- Helper to fetch the key (security definer, admin/service only)
create or replace function public._turnitin_key() returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'turnitin_enc_key' limit 1
$$;
revoke all on function public._turnitin_key() from public, anon, authenticated;

-- Encrypt/decrypt helpers
create or replace function public.encrypt_account_password(plain text) returns bytea
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return pgp_sym_encrypt(plain, public._turnitin_key());
end $$;
revoke all on function public.encrypt_account_password(text) from public, anon, authenticated;
grant execute on function public.encrypt_account_password(text) to service_role;

create or replace function public.decrypt_account_password(account uuid) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v bytea;
begin
  select password_encrypted into v from public.turnitin_accounts where id = account;
  if v is null then return null; end if;
  return pgp_sym_decrypt(v, public._turnitin_key());
end $$;
revoke all on function public.decrypt_account_password(uuid) from public, anon, authenticated;
grant execute on function public.decrypt_account_password(uuid) to service_role;

-- Accounts
create table public.turnitin_accounts (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  email text not null,
  password_encrypted bytea not null,
  login_url text not null default 'https://www.turnitin.com/login_page.asp?lang=en_us',
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.turnitin_accounts to authenticated;
grant all on public.turnitin_accounts to service_role;
alter table public.turnitin_accounts enable row level security;
create policy turnitin_accounts_admin_all on public.turnitin_accounts for all to authenticated
  using (is_admin()) with check (is_admin());
create trigger trg_turnitin_accounts_updated before update on public.turnitin_accounts
  for each row execute function public.set_updated_at();

-- Slots
create table public.turnitin_slots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.turnitin_accounts(id) on delete cascade,
  label text not null,
  submit_url text,
  cooldown_hours integer not null default 24,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_turnitin_slots_account on public.turnitin_slots(account_id);
grant select, insert, update, delete on public.turnitin_slots to authenticated;
grant all on public.turnitin_slots to service_role;
alter table public.turnitin_slots enable row level security;
create policy turnitin_slots_admin_all on public.turnitin_slots for all to authenticated
  using (is_admin()) with check (is_admin());
create trigger trg_turnitin_slots_updated before update on public.turnitin_slots
  for each row execute function public.set_updated_at();

-- Slot usage history
create table public.turnitin_slot_usage (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.turnitin_slots(id) on delete cascade,
  job_id uuid not null,
  submitted_at timestamptz not null default now(),
  freed_at timestamptz,
  turnitin_submission_id text
);
create index idx_slot_usage_slot_time on public.turnitin_slot_usage(slot_id, submitted_at desc);
create index idx_slot_usage_job on public.turnitin_slot_usage(job_id);
grant select, insert, update, delete on public.turnitin_slot_usage to authenticated;
grant all on public.turnitin_slot_usage to service_role;
alter table public.turnitin_slot_usage enable row level security;
create policy turnitin_slot_usage_admin_all on public.turnitin_slot_usage for all to authenticated
  using (is_admin()) with check (is_admin());

-- Extend jobs
alter table public.jobs
  add column if not exists slot_id uuid references public.turnitin_slots(id),
  add column if not exists turnitin_submission_id text,
  add column if not exists worker_id text,
  add column if not exists last_polled_at timestamptz;

-- Atomic claim function
create or replace function public.claim_next_job(p_worker_id text)
returns public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot_id uuid;
  v_job public.jobs;
begin
  -- pick first free slot (no usage within cooldown)
  select s.id into v_slot_id
  from public.turnitin_slots s
  join public.turnitin_accounts a on a.id = s.account_id
  where s.is_active and a.is_active
    and not exists (
      select 1 from public.turnitin_slot_usage u
      where u.slot_id = s.id
        and u.submitted_at > now() - make_interval(hours => s.cooldown_hours)
    )
  order by s.created_at
  limit 1
  for update skip locked;

  if v_slot_id is null then return null; end if;

  -- pick the oldest queued job
  update public.jobs j
  set status = 'processing',
      slot_id = v_slot_id,
      worker_id = p_worker_id,
      started_at = now(),
      last_polled_at = now(),
      attempts = j.attempts + 1,
      updated_at = now()
  where j.id = (
    select id from public.jobs
    where status = 'queued'
    order by created_at
    limit 1
    for update skip locked
  )
  returning * into v_job;

  if v_job.id is null then return null; end if;

  insert into public.turnitin_slot_usage(slot_id, job_id) values (v_slot_id, v_job.id);
  return v_job;
end $$;
revoke all on function public.claim_next_job(text) from public, anon, authenticated;
grant execute on function public.claim_next_job(text) to service_role;

-- Watchdog: re-queue jobs whose worker died
create or replace function public.requeue_stuck_jobs(p_max_age_minutes int default 45)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  with stuck as (
    update public.jobs
    set status = 'queued', worker_id = null, slot_id = null,
        error = coalesce(error,'') || ' [watchdog requeued]', updated_at = now()
    where status = 'processing'
      and last_polled_at < now() - make_interval(mins => p_max_age_minutes)
    returning id
  )
  select count(*) into n from stuck;
  -- free their usage rows
  update public.turnitin_slot_usage
  set freed_at = now()
  where job_id in (select id from public.jobs where status = 'queued' and worker_id is null)
    and freed_at is null;
  return n;
end $$;
revoke all on function public.requeue_stuck_jobs(int) from public, anon, authenticated;
grant execute on function public.requeue_stuck_jobs(int) to service_role;
