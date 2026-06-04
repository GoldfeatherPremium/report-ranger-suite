REVOKE ALL ON FUNCTION public.retry_job(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_job(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.cancel_job(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_job(uuid) TO service_role;