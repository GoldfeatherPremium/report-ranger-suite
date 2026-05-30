
create or replace function public.add_turnitin_account(
  p_label text, p_email text, p_password text, p_login_url text, p_notes text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare new_id uuid;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  insert into public.turnitin_accounts(label, email, password_encrypted, login_url, notes)
  values (p_label, p_email, public.encrypt_account_password(p_password), coalesce(p_login_url,'https://www.turnitin.com/login_page.asp?lang=en_us'), p_notes)
  returning id into new_id;
  return new_id;
end $$;
grant execute on function public.add_turnitin_account(text,text,text,text,text) to authenticated;
