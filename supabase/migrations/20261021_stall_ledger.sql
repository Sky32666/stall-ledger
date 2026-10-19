-- ─────────────────────────────────────────────────────────────────────────────
-- Stall Ledger: daily closings, item sales, recipes, stock, monthly P&L.
-- Separate from the POS tables (all prefixed ledger_).
--
-- Access: anyone can create an account in the app, but only members can read
-- or write ledger data. A new account asks to join (ledger_join_requests) and
-- an owner approves it in the app's Settings → People.
--
-- Run in Supabase → SQL Editor. Safe to run again after updates (every
-- statement is idempotent). Then make yourself the first owner:
--   insert into ledger_members (email, role) values ('you@example.com', 'owner')
--   on conflict (email) do update set role = 'owner';
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Members and owners ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger_members (
  email      TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE ledger_members ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'staff';
ALTER TABLE ledger_members DROP CONSTRAINT IF EXISTS ledger_members_role_check;
ALTER TABLE ledger_members ADD CONSTRAINT ledger_members_role_check CHECK (role IN ('owner', 'staff'));

CREATE OR REPLACE FUNCTION ledger_my_email()
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

CREATE OR REPLACE FUNCTION is_ledger_member()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM ledger_members WHERE lower(email) = ledger_my_email());
$$;

CREATE OR REPLACE FUNCTION is_ledger_owner()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM ledger_members WHERE lower(email) = ledger_my_email() AND role = 'owner');
$$;

REVOKE ALL ON FUNCTION is_ledger_member() FROM public;
REVOKE ALL ON FUNCTION is_ledger_owner() FROM public;
GRANT EXECUTE ON FUNCTION is_ledger_member() TO authenticated;
GRANT EXECUTE ON FUNCTION is_ledger_owner() TO authenticated;

-- Members see their own row; owners see everyone. Changes go through the
-- functions below, so there are no insert/update/delete policies.
ALTER TABLE ledger_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ledger_members_self ON ledger_members;
CREATE POLICY ledger_members_self ON ledger_members
  FOR SELECT TO authenticated
  USING (lower(email) = ledger_my_email() OR is_ledger_owner());

-- ── Join requests (new accounts waiting for approval) ────────────────────────
CREATE TABLE IF NOT EXISTS ledger_join_requests (
  email      TEXT PRIMARY KEY,
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE ledger_join_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ledger_join_requests_read ON ledger_join_requests;
CREATE POLICY ledger_join_requests_read ON ledger_join_requests
  FOR SELECT TO authenticated
  USING (lower(email) = ledger_my_email() OR is_ledger_owner());

-- Signed-in, not-yet-member user asks to join (their own email only)
CREATE OR REPLACE FUNCTION ledger_request_access(p_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF ledger_my_email() = '' THEN RAISE EXCEPTION 'not signed in'; END IF;
  IF is_ledger_member() THEN RETURN; END IF;
  INSERT INTO ledger_join_requests (email, name)
  VALUES (ledger_my_email(), nullif(left(trim(coalesce(p_name, '')), 60), ''))
  ON CONFLICT (email) DO UPDATE SET name = coalesce(EXCLUDED.name, ledger_join_requests.name);
END;
$$;

-- Owner approves (as staff) or declines a request
CREATE OR REPLACE FUNCTION ledger_decide_request(p_email TEXT, p_approve BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_ledger_owner() THEN RAISE EXCEPTION 'only an owner can do this'; END IF;
  IF p_approve THEN
    INSERT INTO ledger_members (email, role) VALUES (lower(p_email), 'staff') ON CONFLICT (email) DO NOTHING;
  END IF;
  DELETE FROM ledger_join_requests WHERE lower(email) = lower(p_email);
END;
$$;

-- Owner removes a member or changes their role; owners cannot demote or remove themselves
CREATE OR REPLACE FUNCTION ledger_set_member(p_email TEXT, p_role TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_ledger_owner() THEN RAISE EXCEPTION 'only an owner can do this'; END IF;
  IF lower(p_email) = ledger_my_email() THEN RAISE EXCEPTION 'you cannot change your own access'; END IF;
  IF p_role IS NULL THEN
    DELETE FROM ledger_members WHERE lower(email) = lower(p_email);
  ELSIF p_role IN ('owner', 'staff') THEN
    UPDATE ledger_members SET role = p_role WHERE lower(email) = lower(p_email);
  ELSE
    RAISE EXCEPTION 'bad role %', p_role;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION ledger_request_access(TEXT) FROM public;
REVOKE ALL ON FUNCTION ledger_decide_request(TEXT, BOOLEAN) FROM public;
REVOKE ALL ON FUNCTION ledger_set_member(TEXT, TEXT) FROM public;
GRANT EXECUTE ON FUNCTION ledger_request_access(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION ledger_decide_request(TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION ledger_set_member(TEXT, TEXT) TO authenticated;

-- ── Data tables ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger_settings (
  id         TEXT PRIMARY KEY,                 -- 'main'
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per stall per day; id = '<YYYY-MM-DD>_<outlet>'
CREATE TABLE IF NOT EXISTS ledger_closings (
  id         TEXT PRIMARY KEY,
  date       DATE NOT NULL,
  outlet_id  TEXT NOT NULL,
  total      INTEGER NOT NULL CHECK (total >= 0),  -- cents
  pay        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {cash, card, paynow, delivery, other} cents
  orders     INTEGER,
  note       TEXT,
  photo_path TEXT,                                 -- storage path in bucket ledger-photos
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID DEFAULT auth.uid()
);
CREATE INDEX IF NOT EXISTS idx_ledger_closings_date ON ledger_closings (date DESC);
-- Per-item sales for the day: [{name, qty, amount}] (amount in cents)
ALTER TABLE ledger_closings ADD COLUMN IF NOT EXISTS items_sold JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS ledger_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  unit       TEXT NOT NULL DEFAULT 'pcs',
  category   TEXT,
  low        NUMERIC,                              -- alert when qty <= low
  qty        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {outlet_id: quantity}
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_moves (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    UUID NOT NULL REFERENCES ledger_items(id),
  item_name  TEXT NOT NULL,
  unit       TEXT NOT NULL,
  outlet_id  TEXT NOT NULL,
  type       TEXT NOT NULL,                        -- in | count | waste | sale (see constraint below)
  qty        NUMERIC NOT NULL,                     -- in/waste/sale: amount; count: amount used (before - after)
  before     NUMERIC NOT NULL,
  after      NUMERIC NOT NULL,
  cost       INTEGER NOT NULL DEFAULT 0,           -- cents, stock-in only
  supplier   TEXT,
  note       TEXT,
  date       DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID DEFAULT auth.uid()
);
CREATE INDEX IF NOT EXISTS idx_ledger_moves_date ON ledger_moves (date DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_moves_created ON ledger_moves (created_at DESC);

-- 'sale' moves are written automatically from a day's items sold (via recipes).
-- closing_id ties them to that day so re-saving the day only applies the difference.
ALTER TABLE ledger_moves ADD COLUMN IF NOT EXISTS closing_id TEXT;
ALTER TABLE ledger_moves DROP CONSTRAINT IF EXISTS ledger_moves_type_check;
ALTER TABLE ledger_moves ADD CONSTRAINT ledger_moves_type_check CHECK (type IN ('in', 'count', 'waste', 'sale'));
CREATE INDEX IF NOT EXISTS idx_ledger_moves_closing ON ledger_moves (closing_id) WHERE closing_id IS NOT NULL;

-- What one portion of each dish uses from stock.
-- dish = lower-cased dish name, matched against items_sold names.
CREATE TABLE IF NOT EXISTS ledger_recipes (
  dish       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,                        -- display name
  lines      JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{item_id, qty}] per portion, in the item's unit
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per stall per month; id = '<YYYY-MM>_<outlet>'
CREATE TABLE IF NOT EXISTS ledger_expenses (
  id         TEXT PRIMARY KEY,
  month      TEXT NOT NULL,                        -- 'YYYY-MM'
  outlet_id  TEXT NOT NULL,
  lines      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {rent, wages, utilities, gas, commission, misc} cents
  note       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID DEFAULT auth.uid()
);
CREATE INDEX IF NOT EXISTS idx_ledger_expenses_month ON ledger_expenses (month);

-- ── Row level security: members only ─────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_settings','ledger_closings','ledger_items','ledger_moves','ledger_expenses','ledger_recipes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_members', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO authenticated USING (is_ledger_member()) WITH CHECK (is_ledger_member())',
      t || '_members', t);
  END LOOP;
END $$;

-- ── Stock movement: insert the record and update the quantity atomically ─────
-- Runs as the caller (RLS still applies). Locks the item row so two phones
-- recording at once cannot lose an update.
CREATE OR REPLACE FUNCTION ledger_record_move(
  p_item_id  UUID,
  p_outlet   TEXT,
  p_type     TEXT,
  p_qty      NUMERIC,
  p_cost     INTEGER,
  p_supplier TEXT,
  p_note     TEXT,
  p_date     DATE
) RETURNS ledger_moves
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  it      ledger_items;
  v_before NUMERIC;
  v_after  NUMERIC;
  v_qty    NUMERIC;
  mv       ledger_moves;
BEGIN
  IF p_type NOT IN ('in', 'count', 'waste') THEN RAISE EXCEPTION 'bad move type %', p_type; END IF;
  IF p_qty IS NULL OR p_qty < 0 THEN RAISE EXCEPTION 'quantity must be >= 0'; END IF;

  SELECT * INTO it FROM ledger_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item not found'; END IF;

  v_before := coalesce((it.qty ->> p_outlet)::numeric, 0);
  v_after  := CASE p_type WHEN 'in' THEN v_before + p_qty WHEN 'waste' THEN v_before - p_qty ELSE p_qty END;
  v_qty    := CASE p_type WHEN 'count' THEN v_before - v_after ELSE p_qty END;

  INSERT INTO ledger_moves (item_id, item_name, unit, outlet_id, type, qty, before, after, cost, supplier, note, date)
  VALUES (it.id, it.name, it.unit, p_outlet, p_type, round(v_qty, 2), v_before, round(v_after, 2),
          CASE WHEN p_type = 'in' THEN greatest(coalesce(p_cost, 0), 0) ELSE 0 END,
          nullif(trim(p_supplier), ''), nullif(trim(p_note), ''), coalesce(p_date, current_date))
  RETURNING * INTO mv;

  UPDATE ledger_items SET qty = qty || jsonb_build_object(p_outlet, round(v_after, 2)) WHERE id = it.id;
  RETURN mv;
END;
$$;

GRANT EXECUTE ON FUNCTION ledger_record_move(UUID, TEXT, TEXT, NUMERIC, INTEGER, TEXT, TEXT, DATE) TO authenticated;

-- ── Deduct stock for a day's items sold ──────────────────────────────────────
-- Works out what the day's sales should have used (items_sold × recipes),
-- compares it with the 'sale' moves already written for that day, and writes
-- only the difference. Safe to call after every save of the day: saving 25
-- Chicken Chop after first saving 23 deducts 2 more; removing a dish puts its
-- stock back. Returns one row per stock item it changed.
CREATE OR REPLACE FUNCTION ledger_apply_sales(p_closing_id TEXT)
RETURNS TABLE (o_item_name TEXT, o_unit TEXT, o_change NUMERIC, o_after NUMERIC)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
#variable_conflict use_column
DECLARE
  c        ledger_closings;
  r        RECORD;
  it       ledger_items;
  v_before NUMERIC;
  v_after  NUMERIC;
BEGIN
  SELECT * INTO c FROM ledger_closings WHERE id = p_closing_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'day not found'; END IF;

  FOR r IN
    WITH sold AS (
      SELECT lower(trim(s ->> 'name')) AS dish, coalesce((s ->> 'qty')::numeric, 0) AS qty
      FROM jsonb_array_elements(c.items_sold) AS s
    ), needed AS (
      SELECT (l ->> 'item_id')::uuid AS item, sum(sold.qty * (l ->> 'qty')::numeric) AS qty
      FROM sold
      JOIN ledger_recipes rc ON rc.dish = sold.dish
      CROSS JOIN LATERAL jsonb_array_elements(rc.lines) AS l
      GROUP BY 1
    ), applied AS (
      SELECT m.item_id AS item, sum(m.qty) AS qty
      FROM ledger_moves m
      WHERE m.closing_id = p_closing_id AND m.type = 'sale'
      GROUP BY 1
    )
    SELECT coalesce(n.item, a.item) AS item, round(coalesce(n.qty, 0) - coalesce(a.qty, 0), 2) AS delta
    FROM needed n
    FULL JOIN applied a ON a.item = n.item
  LOOP
    CONTINUE WHEN r.delta IS NULL OR r.delta = 0;
    SELECT * INTO it FROM ledger_items WHERE id = r.item FOR UPDATE;
    CONTINUE WHEN NOT FOUND;

    v_before := coalesce((it.qty ->> c.outlet_id)::numeric, 0);
    v_after  := round(v_before - r.delta, 2);

    INSERT INTO ledger_moves (item_id, item_name, unit, outlet_id, type, qty, before, after, cost, note, date, closing_id)
    VALUES (it.id, it.name, it.unit, c.outlet_id, 'sale', r.delta, v_before, v_after, 0,
            CASE WHEN r.delta > 0 THEN 'Sold on ' ELSE 'Correction for ' END || to_char(c.date, 'DD Mon'),
            c.date, p_closing_id);

    UPDATE ledger_items SET qty = qty || jsonb_build_object(c.outlet_id, v_after) WHERE id = it.id;

    o_item_name := it.name; o_unit := it.unit; o_change := -r.delta; o_after := v_after;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION ledger_apply_sales(TEXT) TO authenticated;

-- ── Photo storage: private bucket, members only ─────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('ledger-photos', 'ledger-photos', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS ledger_photos_read ON storage.objects;
CREATE POLICY ledger_photos_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'ledger-photos' AND is_ledger_member());

DROP POLICY IF EXISTS ledger_photos_insert ON storage.objects;
CREATE POLICY ledger_photos_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'ledger-photos' AND is_ledger_member());

-- Starting settings: one stall; add the second one later in the app's Settings tab
INSERT INTO ledger_settings (id, data)
VALUES ('main', '{"outlets":[{"id":"a","name":"Stall 1"}]}'::jsonb)
ON CONFLICT (id) DO NOTHING;
