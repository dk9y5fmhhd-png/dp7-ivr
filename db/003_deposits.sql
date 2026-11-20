-- =====================================================================
--  003 — Deposits (daily Excel upload)
--
--  Asli baat: ek username ke KAI deposit aate hain, kai din me.
--  Isliye deposit ek "event" hai, customer ka field nahi.
--
--  Call ki shart: sabse AAKHRI deposit ke 7 din baad.
--  Matlab: MAX(deposit_at) per username.
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- 1. Deposits table — roz ka Excel yahan append hota hai
-- ---------------------------------------------------------------------
-- Deposit report me phone nahi hota. To customer row ban sake bina phone
-- ke, warna hum us user ko track hi nahi kar paayenge.
ALTER TABLE ivr_customers ALTER COLUMN phone DROP NOT NULL;

CREATE TABLE IF NOT EXISTS ivr_deposits (
  id            bigserial PRIMARY KEY,
  username      text NOT NULL,              -- Excel ka username (join key)
  deposit_at    timestamptz NOT NULL,       -- deposit ka date + time
  amount_rupees integer,
  txn_ref       text,                       -- UTR / txn id, ho to
  source_file   text,                       -- kaunsi Excel se aaya
  raw_row       jsonb,                      -- original row, debugging ke liye
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Ek hi deposit dobara upload hone pe duplicate na bane.
-- Roz wahi Excel do baar chala do -> galti se double count nahi hoga.
CREATE UNIQUE INDEX IF NOT EXISTS ivr_deposits_dedupe_uq
  ON ivr_deposits (
    lower(username),
    deposit_at,
    COALESCE(amount_rupees, 0),
    COALESCE(txn_ref, '')
  );

-- "is user ka last deposit" — yahi query sabse zyada chalegi
CREATE INDEX IF NOT EXISTS ivr_deposits_user_idx
  ON ivr_deposits (lower(username), deposit_at DESC);

-- ---------------------------------------------------------------------
-- 2. View — ab last deposit ka source deposits table hai
--
--    Precedence: GREATEST() teeno me se jo bhi non-null ho aur sabse
--    late ho, wahi leta hai. Postgres me GREATEST NULL ko ignore karta hai.
--      1. deposits table ka MAX(deposit_at)   <- daily Excel
--      2. ivr_customers.last_deposit_at       <- purana field (agar ho)
--      3. ivr_customers.created_at            <- kabhi deposit hi nahi kiya
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS ivr_callable_customers;

CREATE VIEW ivr_callable_customers AS
SELECT
  c.customer_key,
  c.name,
  c.name_hi,
  COALESCE(c.name_hi, c.name)                                  AS name_tts,
  c.phone,
  COALESCE(c.phone_e164, normalize_phone(c.phone))             AS phone_e164,
  COALESCE(
    GREATEST(d.last_deposit_at, c.last_deposit_at),
    c.created_at
  )                                                            AS last_deposit_at,
  c.min_deposit_rupees,
  c.is_active,
  c.do_not_call,
  c.language,
  d.deposit_count,
  d.total_deposited_rupees
FROM ivr_customers c
LEFT JOIN LATERAL (
  SELECT MAX(x.deposit_at)                    AS last_deposit_at,
         COUNT(*)::int                        AS deposit_count,
         SUM(x.amount_rupees)::int            AS total_deposited_rupees
  FROM   ivr_deposits x
  WHERE  lower(x.username) = lower(c.customer_key)
) d ON true;

-- ---------------------------------------------------------------------
-- 3. Roz ka use — kaunsi Excel kab aayi
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deposit_uploads (
  id           bigserial PRIMARY KEY,
  filename     text,
  rows_in      integer NOT NULL DEFAULT 0,
  rows_new     integer NOT NULL DEFAULT 0,
  rows_dup     integer NOT NULL DEFAULT 0,
  rows_bad     integer NOT NULL DEFAULT 0,
  users_seen   integer NOT NULL DEFAULT 0,
  bad_reasons  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMIT;


