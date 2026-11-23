-- Audit fix: pairing start was only limited per server instance and by a global pending cap, so one
-- client could fill the 200 pending slots and block pairing for everyone for ten minutes. Starts are
-- now also limited per client address (stored only as a SHA-256 hash).

create table public.pairing_starts (
  id      bigint generated always as identity primary key,
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  at      timestamptz not null default clock_timestamp()
);
create index pairing_starts_ip_idx on public.pairing_starts (ip_hash, at);

alter table public.pairing_starts enable row level security;
revoke all on public.pairing_starts from anon, authenticated;

drop function public.start_pairing(text, text, integer, integer);

-- start_pairing: returns {ok, reason}. reason: null | 'collision' | 'busy' | 'ip_limited'
create function public.start_pairing(
  p_code text, p_token_hash text, p_ttl_seconds integer, p_max_pending integer,
  p_ip_hash text default null, p_max_per_ip integer default 10, p_ip_window_seconds integer default 3600
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_pending integer;
  v_recent integer;
begin
  perform pg_advisory_xact_lock(hashtext('haltline_pairing'));
  delete from pairing_codes where expires_at < v_now;
  delete from pairing_starts where at < v_now - interval '1 day';

  if p_ip_hash is not null then
    select count(*) into v_recent from pairing_starts
      where ip_hash = p_ip_hash and at >= v_now - make_interval(secs => p_ip_window_seconds);
    if v_recent >= p_max_per_ip then
      return jsonb_build_object('ok', false, 'reason', 'ip_limited');
    end if;
  end if;

  select count(*) into v_pending from pairing_codes where claimed_at is null;
  if v_pending >= p_max_pending then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;

  begin
    insert into pairing_codes (code, token_hash, expires_at)
    values (p_code, p_token_hash, v_now + make_interval(secs => p_ttl_seconds));
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'collision');
  end;

  if p_ip_hash is not null then
    insert into pairing_starts (ip_hash) values (p_ip_hash);
  end if;
  return jsonb_build_object('ok', true, 'reason', null);
end;
$$;

revoke all on function public.start_pairing(text, text, integer, integer, text, integer, integer) from public, anon, authenticated;
grant execute on function public.start_pairing(text, text, integer, integer, text, integer, integer) to service_role;
