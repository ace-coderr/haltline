-- Explicit privileges for the backend role.
--
-- Newer Supabase projects no longer grant table privileges to the API roles automatically
-- (the Data API reports "permission denied ... GRANT SELECT ON public.<table>"), so the
-- service role used by the Edge Functions needs explicit grants. Clients (anon,
-- authenticated) keep only the narrow, read-only grants and RLS policies set in earlier
-- migrations; nothing here widens client access.

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- future tables created by later migrations get the same backend grant
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
