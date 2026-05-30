
revoke execute on function public.add_turnitin_account(text,text,text,text,text) from public, anon;
revoke execute on function public.claim_next_job(text) from public, anon, authenticated;
revoke execute on function public.requeue_stuck_jobs(int) from public, anon, authenticated;
revoke execute on function public.encrypt_account_password(text) from public, anon, authenticated;
revoke execute on function public.decrypt_account_password(uuid) from public, anon, authenticated;
revoke execute on function public._turnitin_key() from public, anon, authenticated;
