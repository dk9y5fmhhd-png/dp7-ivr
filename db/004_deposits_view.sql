-- =====================================================================
--  004 — Asli view: DP7 ke public.deposits se seedha
--
--  DP7 me roz ka Excel `+ Add Data` se jaata hai → public.deposits
--  (username, mobile, play_date, amount, id).
--
--  Ek username ke KAI deposit hote hain. Call us SABSE AAKHRI deposit
--  ke 7 din baad jaati hai → MAX(play_date).
--
--  Agar public.deposits maujood nahi (fresh install), to fallback:
--  IVR ka apna ivr_deposits table use hoga — app kabhi nahi tootegi.
-- =====================================================================
DO $mig$
DECLARE
  has_dp7 boolean := to_regclass('public.deposits') IS NOT NULL;
BEGIN
  -- purani view hat jaye, warna CREATE column badalne nahi dega
  DROP VIEW IF EXISTS ivr_callable_customers;

  IF has_dp7 THEN
    EXECUTE $v$
      CREATE VIEW ivr_callable_customers AS
      WITH last_dep AS (
        -- har username ki SABSE AAKHRI deposit row — mobile wahin se,
        -- taaki purana number use na hua jaaye
        SELECT DISTINCT ON (lower(trim(d.username)))
               d.username,
               d.mobile,
               d.play_date
        FROM   public.deposits d
        WHERE  d.username IS NOT NULL AND trim(d.username) <> ''
        ORDER  BY lower(trim(d.username)), d.play_date DESC, d.id DESC
      ),
      agg AS (
        SELECT lower(trim(d.username))          AS ukey,
               MAX(d.play_date)                 AS last_deposit_at,
               COUNT(*)::int                    AS deposit_count,
               COALESCE(SUM(d.amount), 0)::int  AS total_deposited_rupees
        FROM   public.deposits d
        WHERE  d.username IS NOT NULL AND trim(d.username) <> ''
        GROUP  BY lower(trim(d.username))
      )
      SELECT l.username                                             AS customer_key,
             l.username                                             AS name,
             NULL::text                                             AS name_hi,
             l.username                                             AS name_tts,
             l.mobile                                               AS phone,
             normalize_phone(l.mobile)                              AS phone_e164,
             (a.last_deposit_at::timestamp AT TIME ZONE 'Asia/Kolkata') AS last_deposit_at,
             300                                                    AS min_deposit_rupees,
             -- DP7 ka "STATUS: Inactive" ka matlab account band nahi,
             -- "7 din se kuch nahi kiya" hai. Use is_active se jodte to
             -- ek bhi call nahi jaati — isliye yahan true.
             true                                                   AS is_active,
             COALESCE(c.do_not_call, false)                         AS do_not_call,
             'hi'                                                   AS language,
             a.deposit_count,
             a.total_deposited_rupees
      FROM   last_dep l
      JOIN   agg a ON a.ukey = lower(trim(l.username))
      LEFT   JOIN ivr_customers c ON lower(c.customer_key) = lower(trim(l.username))
    $v$;
  ELSE
    -- Fallback: IVR ka apna table (manual CSV upload wala rasta)
    EXECUTE $v$
      CREATE VIEW ivr_callable_customers AS
      SELECT c.customer_key,
             c.name,
             c.name_hi,
             COALESCE(c.name_hi, c.name)                        AS name_tts,
             c.phone,
             COALESCE(c.phone_e164, normalize_phone(c.phone))    AS phone_e164,
             COALESCE(d.last_deposit_at, c.last_deposit_at, c.created_at) AS last_deposit_at,
             c.min_deposit_rupees,
             c.is_active,
             c.do_not_call,
             c.language,
             COALESCE(d.deposit_count, 0)                        AS deposit_count,
             COALESCE(d.total_deposited_rupees, 0)                AS total_deposited_rupees
      FROM   ivr_customers c
      LEFT   JOIN LATERAL (
        SELECT MAX(x.deposit_at)              AS last_deposit_at,
               COUNT(*)::int                  AS deposit_count,
               COALESCE(SUM(x.amount_rupees),0)::int AS total_deposited_rupees
        FROM   ivr_deposits x
        WHERE  lower(x.username) = lower(c.customer_key)
      ) d ON true
    $v$;
  END IF;
END
$mig$;

-- ---------------------------------------------------------------------
--  Trigger: naya deposit aaye to ivr_customers me row banao
--  (opt-out / DNC flag rakhne ke liye ek row chahiye)
--  Kabhi bhi fail ho to DP7 ka INSERT nahi rukna chahiye — isliye
--  poora body EXCEPTION me lipta hai.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ivr_sync_customer_row() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  BEGIN
    INSERT INTO ivr_customers (customer_key, name, phone, source)
    VALUES (NEW.username, NEW.username, NEW.mobile, 'dp7_deposits')
    ON CONFLICT (customer_key) DO UPDATE
      SET phone = COALESCE(EXCLUDED.phone, ivr_customers.phone),
          updated_at = now();
  EXCEPTION WHEN OTHERS THEN
    NULL;   -- DP7 ka insert kabhi fail nahi hoga
  END;
  RETURN NEW;
END;
$fn$;

DO $trg$
BEGIN
  IF to_regclass('public.deposits') IS NOT NULL
     AND to_regclass('public.ivr_customers') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS ivr_sync_customer ON public.deposits';
    EXECUTE $t$
      CREATE TRIGGER ivr_sync_customer
      AFTER INSERT ON public.deposits
      FOR EACH ROW WHEN (NEW.username IS NOT NULL)
      EXECUTE FUNCTION ivr_sync_customer_row()
    $t$;
  END IF;
END
$trg$;

-- purane users ke liye ek baar bhar do (DNC flag ke liye row chahiye)
DO $seed$
BEGIN
  IF to_regclass('public.deposits') IS NOT NULL THEN
    INSERT INTO ivr_customers (customer_key, name, phone, source)
    SELECT DISTINCT ON (lower(trim(d.username)))
           d.username, d.username, d.mobile, 'dp7_deposits'
    FROM   public.deposits d
    WHERE  d.username IS NOT NULL AND trim(d.username) <> ''
    ORDER  BY lower(trim(d.username)), d.play_date DESC
    ON CONFLICT (customer_key) DO NOTHING;
  END IF;
END
$seed$;

