-- ─────────────────────────────────────────────────────────────────────────────
-- 档口账本 (stall ledger): daily closings, stock, monthly P&L.
-- Separate from the POS tables (all prefixed ledger_). Only signed-in users
-- whose email is in ledger_members can read or write anything.
--
-- Run once in Supabase → SQL Editor. Then add each person:
--   1. Authentication → Users → Add user (email + password, auto-confirm)
--   2. insert into ledger_members (email) values ('sister@example.com');
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Members (allow-list) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger_members (
  email      TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION is_ledger_member()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM ledger_members
    WHERE lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

REVOKE ALL ON FUNCTION is_ledger_member() FROM public;
GRANT EXECUTE ON FUNCTION is_ledger_member() TO authenticated;

ALTER TABLE ledger_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ledger_members_self ON ledger_members;
CREATE POLICY ledger_members_self ON ledger_members
  FOR SELECT TO authenticated
  USING (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

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

CREATE TABLE IF NOT EXISTS ledger_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  unit       TEXT NOT NULL DEFAULT '个',
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
  type       TEXT NOT NULL CHECK (type IN ('in', 'count', 'waste')),
  qty        NUMERIC NOT NULL,                     -- in/waste: amount; count: amount used (before - after)
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
  FOREACH t IN ARRAY ARRAY['ledger_settings','ledger_closings','ledger_items','ledger_moves','ledger_expenses'] LOOP
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
VALUES ('main', '{"outlets":[{"id":"a","name":"档口 1"}]}'::jsonb)
ON CONFLICT (id) DO NOTHING;
