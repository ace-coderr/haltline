-- Haltline schema. Testnet/paper only; no funds are held.
--
-- Access model: clients (web, anonymous or magic-link users) may only READ their own rows.
-- Every write goes through Edge Functions using the service role, which validate input,
-- enforce the kill switch and cooldown, and write the actions log. The glasses app has no
-- Supabase session at all: it authenticates to Edge Functions with a device token whose
-- SHA-256 hash is stored in public.devices.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.limits (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  -- null = the user has not set a limit yet (the UI shows an honest "no limit set" state)
  daily_limit    numeric(12, 2) check (daily_limit is null or (daily_limit >= 1 and daily_limit <= 1000000)),
  -- kill switch: when true, every write action is refused server-side
  kill_switch    boolean not null default false,
  -- time of the last write action that claimed the cooldown slot
  last_action_at timestamptz,
  updated_at     timestamptz not null default now()
);

create table public.devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- SHA-256 hex of the device token. The token itself is never stored.
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label        text not null default 'Even G2' check (char_length(label) between 1 and 40),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);
create index devices_user_idx on public.devices (user_id);

create table public.pairing_codes (
  code       text primary key check (code ~ '^[0-9]{6}$'),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- set when the user enters the code on the web settings page
  user_id    uuid references auth.users (id) on delete cascade,
  claimed_at timestamptz
);
create index pairing_codes_expires_idx on public.pairing_codes (expires_at);

-- One row per user per UTC day: the trading session the limit applies to.
create table public.sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  day            date not null,
  limit_at_start numeric(12, 2) not null,
  started_at     timestamptz not null default now(),
  tripped_at     timestamptz,
  unique (user_id, day)
);

-- A prepared (not yet confirmed) action. Confirming consumes it exactly once.
create table public.proposals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  device_id   uuid references public.devices (id) on delete set null,
  kind        text not null check (kind in ('cut_half', 'cut_all')),
  -- the planned reduce-only orders, as computed at proposal time
  orders      jsonb not null,
  created_at  timestamptz not null default clock_timestamp(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);
create index proposals_user_idx on public.proposals (user_id, created_at desc);

-- Every action, one row per order leg (or one row for non-order actions).
create table public.actions_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  device_id   uuid references public.devices (id) on delete set null,
  proposal_id uuid references public.proposals (id) on delete set null,
  kind        text not null check (kind in ('cut_half', 'cut_all', 'dismiss', 'set_limit', 'kill_switch')),
  status      text not null check (status in ('executed', 'failed', 'rejected')),
  -- why a rejection/failure happened (cooldown, kill_switch, expired, exchange error ...)
  reason      text,
  symbol      text,
  side        text check (side is null or side in ('Buy', 'Sell')),
  size        numeric,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default clock_timestamp()
);
create index actions_log_user_idx on public.actions_log (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security: clients read their own data, nothing else.
-- ---------------------------------------------------------------------------

alter table public.limits        enable row level security;
alter table public.devices       enable row level security;
alter table public.pairing_codes enable row level security;
alter table public.sessions      enable row level security;
alter table public.proposals     enable row level security;
alter table public.actions_log   enable row level security;

create policy limits_read_own      on public.limits      for select to authenticated using (user_id = auth.uid());
create policy devices_read_own     on public.devices     for select to authenticated using (user_id = auth.uid());
create policy sessions_read_own    on public.sessions    for select to authenticated using (user_id = auth.uid());
create policy actions_log_read_own on public.actions_log for select to authenticated using (user_id = auth.uid());
-- pairing_codes and proposals: no policies, service role only.

revoke all on public.limits, public.devices, public.pairing_codes,
              public.sessions, public.proposals, public.actions_log
  from anon, authenticated;

grant select on public.limits, public.sessions, public.actions_log to authenticated;
-- devices: never expose token_hash, even though only the hash is stored
grant select (id, user_id, label, created_at, last_seen_at, revoked_at) on public.devices to authenticated;

-- ---------------------------------------------------------------------------
-- Atomic helpers (service role only). These make the cooldown and the
-- confirm-once rule race-free: two concurrent requests cannot both pass.
-- ---------------------------------------------------------------------------

-- Claims the single write-action slot for a user.
-- Returns {ok, reason, retry_after_seconds, previous}. reason: null | 'kill_switch' | 'cooldown'.
create function public.claim_action_slot(p_user uuid, p_cooldown_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row limits%rowtype;
  v_previous timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if p_cooldown_seconds is null or p_cooldown_seconds < 0 then
    raise exception 'invalid cooldown';
  end if;

  insert into limits (user_id) values (p_user) on conflict (user_id) do nothing;

  -- lock the row so concurrent claims serialise
  select * into v_row from limits where user_id = p_user for update;
  v_previous := v_row.last_action_at;

  if v_row.kill_switch then
    return jsonb_build_object('ok', false, 'reason', 'kill_switch', 'retry_after_seconds', 0, 'previous', v_previous);
  end if;

  if v_previous is not null and v_previous > v_now then
    -- clock anomaly: fail closed
    return jsonb_build_object('ok', false, 'reason', 'cooldown', 'retry_after_seconds', p_cooldown_seconds, 'previous', v_previous);
  end if;

  if v_previous is not null and v_now < v_previous + make_interval(secs => p_cooldown_seconds) then
    return jsonb_build_object(
      'ok', false, 'reason', 'cooldown',
      'retry_after_seconds', ceil(extract(epoch from (v_previous + make_interval(secs => p_cooldown_seconds) - v_now))),
      'previous', v_previous
    );
  end if;

  update limits set last_action_at = v_now, updated_at = v_now where user_id = p_user;
  return jsonb_build_object('ok', true, 'reason', null, 'retry_after_seconds', 0, 'previous', v_previous, 'claimed_at', v_now);
end;
$$;

-- Gives the slot back ONLY when nothing was executed (e.g. the exchange was unreachable),
-- so a failed attempt does not lock the user out. Restores only if our claim is still the latest.
create function public.release_action_slot(p_user uuid, p_claimed_at timestamptz, p_previous timestamptz)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update limits set last_action_at = p_previous, updated_at = clock_timestamp()
   where user_id = p_user and last_action_at = p_claimed_at;
  return found;
end;
$$;

-- Consumes a proposal exactly once. Returns {ok, reason, orders}.
-- reason: null | 'missing' | 'consumed' | 'expired' | 'kind_mismatch' | 'too_soon'
create function public.consume_proposal(p_id uuid, p_user uuid, p_kind text, p_min_delay_ms integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row proposals%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_row from proposals where id = p_id and user_id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'missing');
  end if;
  if v_row.consumed_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'consumed');
  end if;
  if v_now >= v_row.expires_at then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if v_row.kind <> p_kind then
    return jsonb_build_object('ok', false, 'reason', 'kind_mismatch');
  end if;
  if v_now < v_row.created_at + make_interval(secs => p_min_delay_ms / 1000.0) then
    return jsonb_build_object('ok', false, 'reason', 'too_soon');
  end if;

  update proposals set consumed_at = v_now where id = p_id;
  return jsonb_build_object('ok', true, 'reason', null, 'orders', v_row.orders);
end;
$$;

revoke all on function public.claim_action_slot(uuid, integer)                from public, anon, authenticated;
revoke all on function public.release_action_slot(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.consume_proposal(uuid, uuid, text, integer)     from public, anon, authenticated;
grant execute on function public.claim_action_slot(uuid, integer)                 to service_role;
grant execute on function public.release_action_slot(uuid, timestamptz, timestamptz) to service_role;
grant execute on function public.consume_proposal(uuid, uuid, text, integer)     to service_role;
