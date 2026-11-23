-- Pairing flow helpers with brute-force protection.
--
-- Flow: glasses call start_pairing (gets a 6-digit code + secret device token; only the
-- token HASH is stored). The user enters the code on the web settings page (claim_pairing_code).
-- The glasses poll redeem_pairing with their token; once the code is claimed it becomes a
-- row in public.devices and the code is deleted.
--
-- Brute force: 10^6 codes and a 10 minute lifetime are not enough on their own, because
-- anonymous accounts are cheap. So failed claims are limited per user AND globally, and
-- every attempt is recorded. The global limit means an attacker can temporarily block
-- pairing for everyone; that is the deliberate trade-off (availability of pairing for
-- confidentiality of the code space), documented in the README.

create table public.pairing_attempts (
  id        bigint generated always as identity primary key,
  user_id   uuid references auth.users (id) on delete cascade,
  succeeded boolean not null,
  at        timestamptz not null default clock_timestamp()
);
create index pairing_attempts_at_idx on public.pairing_attempts (at);
create index pairing_attempts_user_idx on public.pairing_attempts (user_id, at);

alter table public.pairing_attempts enable row level security;
revoke all on public.pairing_attempts from anon, authenticated;

create unique index pairing_codes_token_hash_key on public.pairing_codes (token_hash);

-- start_pairing: returns {ok, reason}. reason: null | 'collision' (retry with a new code) | 'busy'
create function public.start_pairing(
  p_code text, p_token_hash text, p_ttl_seconds integer, p_max_pending integer
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_pending integer;
begin
  perform pg_advisory_xact_lock(hashtext('haltline_pairing'));
  delete from pairing_codes where expires_at < v_now;

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
  return jsonb_build_object('ok', true, 'reason', null);
end;
$$;

-- claim_pairing_code: returns {ok, reason}. reason: null | 'invalid_code' | 'rate_limited'
create function public.claim_pairing_code(
  p_user uuid, p_code text,
  p_max_user_fails integer default 5,
  p_max_global_fails integer default 60,
  p_window_seconds integer default 600
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window timestamptz := clock_timestamp() - make_interval(secs => p_window_seconds);
  v_user_fails integer;
  v_global_fails integer;
  v_updated integer;
begin
  perform pg_advisory_xact_lock(hashtext('haltline_pairing'));
  delete from pairing_codes where expires_at < v_now;
  delete from pairing_attempts where at < v_now - interval '1 day';

  select count(*) into v_user_fails from pairing_attempts
    where user_id = p_user and not succeeded and at >= v_window;
  select count(*) into v_global_fails from pairing_attempts
    where not succeeded and at >= v_window;
  if v_user_fails >= p_max_user_fails or v_global_fails >= p_max_global_fails then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  if p_code is not null and p_code ~ '^[0-9]{6}$' then
    update pairing_codes set user_id = p_user, claimed_at = v_now
     where code = p_code and claimed_at is null and expires_at > v_now;
    get diagnostics v_updated = row_count;
  else
    v_updated := 0;
  end if;

  insert into pairing_attempts (user_id, succeeded) values (p_user, v_updated = 1);
  if v_updated = 1 then
    return jsonb_build_object('ok', true, 'reason', null);
  end if;
  return jsonb_build_object('ok', false, 'reason', 'invalid_code');
end;
$$;

-- redeem_pairing: returns {status, ...}. status: 'unknown' | 'expired' | 'pending' | 'paired'
create function public.redeem_pairing(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row pairing_codes%rowtype;
  v_device uuid;
  v_now timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtext('haltline_pairing'));
  select * into v_row from pairing_codes where token_hash = p_token_hash;
  if not found then
    -- either never existed, expired and swept, or already redeemed
    select id into v_device from devices where token_hash = p_token_hash and revoked_at is null;
    if found then
      return jsonb_build_object('status', 'paired', 'device_id', v_device);
    end if;
    return jsonb_build_object('status', 'unknown');
  end if;

  if v_row.claimed_at is not null then
    insert into devices (user_id, token_hash) values (v_row.user_id, p_token_hash)
      on conflict (token_hash) do nothing;
    select id into v_device from devices where token_hash = p_token_hash;
    delete from pairing_codes where code = v_row.code;
    return jsonb_build_object('status', 'paired', 'device_id', v_device);
  end if;

  if v_row.expires_at <= v_now then
    delete from pairing_codes where code = v_row.code;
    return jsonb_build_object('status', 'expired');
  end if;

  return jsonb_build_object('status', 'pending', 'expires_at', v_row.expires_at);
end;
$$;

revoke all on function public.start_pairing(text, text, integer, integer)               from public, anon, authenticated;
revoke all on function public.claim_pairing_code(uuid, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.redeem_pairing(text)                                      from public, anon, authenticated;
grant execute on function public.start_pairing(text, text, integer, integer)               to service_role;
grant execute on function public.claim_pairing_code(uuid, text, integer, integer, integer) to service_role;
grant execute on function public.redeem_pairing(text)                                      to service_role;
