
REVOKE ALL ON FUNCTION public.create_api_client(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.enqueue_job_callback(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_api_client(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_job_callback(uuid, text) TO service_role;
