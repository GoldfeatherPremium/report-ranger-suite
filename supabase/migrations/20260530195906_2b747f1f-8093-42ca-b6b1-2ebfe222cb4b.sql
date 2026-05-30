
-- set_updated_at: harden search path; only triggers call it
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.is_admin() from public, anon;
-- authenticated still needs is_admin for RLS predicates; SECURITY DEFINER means it runs as owner anyway.
grant execute on function public.is_admin() to authenticated;
