-- PAPER trading account: simulated, priced from real public market data. No real exchange,
-- no real funds. Everything here is service-role-written; clients may only read their own rows
-- (and the public price cache).
--
-- Model (also documented in the README and the API):
--   * one-way (net) positions, linear contracts, quote currency USD, one account per user
--   * fills at the live bid/ask plus a fixed slippage, with a fixed taker fee (rates are
--     passed in by the backend so they live in one place in code)
--   * fees count as realised loss, so they count toward the daily limit

create table public.paper_prices (
  symbol     text primary key check (symbol ~ '^[A-Z0-9]{3,12}$'),
  bid        numeric(24, 10) not null check (bid > 0),
  ask        numeric(24, 10) not null check (ask > 0),
  last       numeric(24, 10) not null check (last > 0),
  -- timestamp reported by the market data source, and when we stored it
  source_ts  timestamptz not null,
  fetched_at timestamptz not null default clock_timestamp(),
  source     text not null
);

create table public.paper_accounts (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  -- cash: starting balance + realised PnL - fees
  balance          numeric(24, 10) not null,
  starting_balance numeric(24, 10) not null check (starting_balance > 0),
  created_at       timestamptz not null default now(),
  reset_at         timestamptz
);

create table public.paper_positions (
  user_id     uuid not null references auth.users (id) on delete cascade,
  symbol      text not null check (symbol ~ '^[A-Z0-9]{3,12}$'),
  side        text not null check (side in ('Buy', 'Sell')),
  size        numeric(24, 10) not null check (size > 0),
  entry_price numeric(24, 10) not null check (entry_price > 0),
  updated_at  timestamptz not null default clock_timestamp(),
  primary key (user_id, symbol)
);

create table public.paper_fills (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  symbol       text not null,
  side         text not null check (side in ('Buy', 'Sell')),
  qty          numeric(24, 10) not null check (qty > 0),
  price        numeric(24, 10) not null check (price > 0),
  fee          numeric(24, 10) not null check (fee >= 0),
  realized_pnl numeric(24, 10) not null,
  reduce_only  boolean not null,
  -- 'manual' = opened/closed on the website panel, 'guard' = placed by the confirmed guard action
  source       text not null check (source in ('manual', 'guard')),
  link_id      text,
  created_at   timestamptz not null default clock_timestamp()
);
create unique index paper_fills_link_key on public.paper_fills (user_id, link_id) where link_id is not null;
create index paper_fills_user_time_idx on public.paper_fills (user_id, created_at desc);

alter table public.paper_prices    enable row level security;
alter table public.paper_accounts  enable row level security;
alter table public.paper_positions enable row level security;
alter table public.paper_fills     enable row level security;

-- public market data: anyone may read the price cache (it is public data)
create policy paper_prices_read_all     on public.paper_prices    for select to anon, authenticated using (true);
create policy paper_accounts_read_own   on public.paper_accounts  for select to authenticated using (user_id = auth.uid());
create policy paper_positions_read_own  on public.paper_positions for select to authenticated using (user_id = auth.uid());
create policy paper_fills_read_own      on public.paper_fills     for select to authenticated using (user_id = auth.uid());

revoke all on public.paper_prices, public.paper_accounts, public.paper_positions, public.paper_fills
  from anon, authenticated;
grant select on public.paper_prices to anon, authenticated;
grant select on public.paper_accounts, public.paper_positions, public.paper_fills to authenticated;

-- ---------------------------------------------------------------------------
-- paper_apply_fill: the single place where positions and balances change.
-- Atomic (locks the account row), idempotent per (user, link_id).
-- Returns {ok, reason, duplicate, fill_id, realized_pnl, fee, balance, position}.
-- reason: null | reduce_only_no_position | reduce_only_wrong_side |
--         reduce_only_exceeds_position | no_mark | insufficient_margin
-- ---------------------------------------------------------------------------
create function public.paper_apply_fill(
  p_user uuid, p_symbol text, p_side text, p_qty numeric, p_price numeric,
  p_fee_rate numeric, p_reduce_only boolean, p_link_id text, p_source text,
  p_max_leverage numeric, p_marks jsonb, p_starting_balance numeric default 10000
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_acct paper_accounts%rowtype;
  v_pos paper_positions%rowtype;
  v_has_pos boolean;
  v_existing paper_fills%rowtype;
  v_fee numeric;
  v_realized numeric := 0;
  v_close_qty numeric := 0;
  v_new_size numeric;
  v_new_side text;
  v_new_entry numeric;
  v_balance numeric;
  v_equity numeric;
  v_notional numeric := 0;
  v_mark numeric;
  v_fill_id uuid;
  r record;
begin
  if p_side not in ('Buy', 'Sell') or p_qty is null or p_qty <= 0 or p_price is null or p_price <= 0
     or p_fee_rate is null or p_fee_rate < 0 or p_fee_rate > 0.01
     or p_source not in ('manual', 'guard') or p_max_leverage is null or p_max_leverage <= 0
     or p_symbol !~ '^[A-Z0-9]{3,12}$' then
    raise exception 'invalid fill parameters';
  end if;

  insert into paper_accounts (user_id, balance, starting_balance)
  values (p_user, p_starting_balance, p_starting_balance)
  on conflict (user_id) do nothing;
  select * into v_acct from paper_accounts where user_id = p_user for update;

  if p_link_id is not null then
    select * into v_existing from paper_fills where user_id = p_user and link_id = p_link_id;
    if found then
      return jsonb_build_object('ok', true, 'reason', null, 'duplicate', true,
        'fill_id', v_existing.id, 'realized_pnl', v_existing.realized_pnl, 'fee', v_existing.fee,
        'balance', v_acct.balance);
    end if;
  end if;

  select * into v_pos from paper_positions where user_id = p_user and symbol = p_symbol for update;
  v_has_pos := found;

  if p_reduce_only then
    if not v_has_pos then
      return jsonb_build_object('ok', false, 'reason', 'reduce_only_no_position');
    elsif v_pos.side = p_side then
      return jsonb_build_object('ok', false, 'reason', 'reduce_only_wrong_side');
    elsif p_qty > v_pos.size then
      return jsonb_build_object('ok', false, 'reason', 'reduce_only_exceeds_position');
    end if;
  end if;

  v_fee := p_qty * p_price * p_fee_rate;

  if not v_has_pos then
    v_new_side := p_side; v_new_size := p_qty; v_new_entry := p_price;
  elsif v_pos.side = p_side then
    v_new_side := p_side; v_new_size := v_pos.size + p_qty;
    v_new_entry := (v_pos.size * v_pos.entry_price + p_qty * p_price) / v_new_size;
  else
    v_close_qty := least(p_qty, v_pos.size);
    v_realized := case when v_pos.side = 'Buy'
                       then (p_price - v_pos.entry_price) * v_close_qty
                       else (v_pos.entry_price - p_price) * v_close_qty end;
    if p_qty < v_pos.size then
      v_new_side := v_pos.side; v_new_size := v_pos.size - p_qty; v_new_entry := v_pos.entry_price;
    elsif p_qty = v_pos.size then
      v_new_side := null; v_new_size := 0; v_new_entry := null;
    else
      v_new_side := p_side; v_new_size := p_qty - v_pos.size; v_new_entry := p_price;
    end if;
  end if;

  v_balance := v_acct.balance + v_realized - v_fee;

  -- margin check, only for fills that open, increase or flip exposure
  if p_qty > v_close_qty then
    v_equity := v_balance;
    for r in select * from paper_positions where user_id = p_user and symbol <> p_symbol loop
      v_mark := nullif(p_marks ->> r.symbol, '')::numeric;
      if v_mark is null or v_mark <= 0 then
        return jsonb_build_object('ok', false, 'reason', 'no_mark');
      end if;
      v_equity := v_equity + case when r.side = 'Buy' then (v_mark - r.entry_price) * r.size
                                  else (r.entry_price - v_mark) * r.size end;
      v_notional := v_notional + r.size * v_mark;
    end loop;
    if v_new_size > 0 then
      v_mark := coalesce(nullif(p_marks ->> p_symbol, '')::numeric, p_price);
      v_equity := v_equity + case when v_new_side = 'Buy' then (v_mark - v_new_entry) * v_new_size
                                  else (v_new_entry - v_mark) * v_new_size end;
      v_notional := v_notional + v_new_size * v_mark;
    end if;
    if v_equity <= 0 or v_notional > p_max_leverage * v_equity then
      return jsonb_build_object('ok', false, 'reason', 'insufficient_margin');
    end if;
  end if;

  if v_new_size = 0 then
    delete from paper_positions where user_id = p_user and symbol = p_symbol;
  elsif v_has_pos then
    update paper_positions
       set side = v_new_side, size = v_new_size, entry_price = v_new_entry, updated_at = clock_timestamp()
     where user_id = p_user and symbol = p_symbol;
  else
    insert into paper_positions (user_id, symbol, side, size, entry_price)
    values (p_user, p_symbol, v_new_side, v_new_size, v_new_entry);
  end if;

  update paper_accounts set balance = v_balance where user_id = p_user;

  insert into paper_fills (user_id, symbol, side, qty, price, fee, realized_pnl, reduce_only, source, link_id)
  values (p_user, p_symbol, p_side, p_qty, p_price, v_fee, v_realized, p_reduce_only, p_source, p_link_id)
  returning id into v_fill_id;

  return jsonb_build_object(
    'ok', true, 'reason', null, 'duplicate', false, 'fill_id', v_fill_id,
    'realized_pnl', v_realized, 'fee', v_fee, 'balance', v_balance,
    'position', case when v_new_size > 0
      then jsonb_build_object('side', v_new_side, 'size', v_new_size, 'entry_price', v_new_entry)
      else null end
  );
end;
$$;

-- Realised PnL since a point in time, net of fees (fees are real losses against the limit).
create function public.paper_realized_since(p_user uuid, p_since timestamptz) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(realized_pnl - fee), 0)
    from paper_fills where user_id = p_user and created_at >= p_since;
$$;

-- Resets cash to the starting balance. Refused while positions are open, and fill history is
-- kept, so a reset cannot wipe today's losses out of the daily-limit calculation.
create function public.paper_reset(p_user uuid, p_starting_balance numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_starting_balance is null or p_starting_balance <= 0 then raise exception 'invalid starting balance'; end if;
  perform 1 from paper_positions where user_id = p_user;
  if found then return jsonb_build_object('ok', false, 'reason', 'has_positions'); end if;
  insert into paper_accounts (user_id, balance, starting_balance, reset_at)
  values (p_user, p_starting_balance, p_starting_balance, now())
  on conflict (user_id) do update
    set balance = excluded.balance, starting_balance = excluded.starting_balance, reset_at = now();
  return jsonb_build_object('ok', true, 'reason', null);
end;
$$;

revoke all on function public.paper_apply_fill(uuid, text, text, numeric, numeric, numeric, boolean, text, text, numeric, jsonb, numeric) from public, anon, authenticated;
revoke all on function public.paper_realized_since(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.paper_reset(uuid, numeric) from public, anon, authenticated;
grant execute on function public.paper_apply_fill(uuid, text, text, numeric, numeric, numeric, boolean, text, text, numeric, jsonb, numeric) to service_role;
grant execute on function public.paper_realized_since(uuid, timestamptz) to service_role;
grant execute on function public.paper_reset(uuid, numeric) to service_role;
