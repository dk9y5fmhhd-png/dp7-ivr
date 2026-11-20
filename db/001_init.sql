-- =====================================================================
--  Retention IVR — schema
--  Ek hi baar chalta hai, dobara chalane pe kuch nahi todta.
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- 1. Phone normalizer
--    +919876543210 / 9876543210 / 09876543210 / 919876543210
--    sab ek hi format me. Invalid number -> NULL (usko call nahi jayegi).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION normalize_phone(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  d text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  d := regexp_replace(p, '[^0-9]', '', 'g');
  IF d = '' THEN RETURN NULL; END IF;

  -- 0XXXXXXXXXX  (11 digits)
  IF length(d) = 11 AND left(d, 1) = '0' THEN
    d := substr(d, 2);
  END IF;

  -- 10 digit Indian mobile
  IF length(d) = 10 AND d ~ '^[6-9]' THEN
    RETURN '+91' || d;
  END IF;

  -- 12 digit with country code
  IF length(d) = 12 AND left(d, 2) = '91' AND substr(d, 3) ~ '^[6-9]' THEN
    RETURN '+' || d;
  END IF;

  -- koi aur country code with +
  IF p LIKE '+%' AND length(d) >= 10 AND length(d) <= 15 THEN
    RETURN '+' || d;
  END IF;

  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------
-- 2. Retention mirror table
--    Retention panel ka data yahan aata hai (CSV upload ya SQL sync).
--    Existing retention table ho to neeche wala VIEW uspe point kar do,
--    yeh table khaali chhod do.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ivr_customers (
  customer_key       text PRIMARY KEY,
  name               text NOT NULL,
  name_hi            text,                         -- optional Devanagari naam (TTS ke liye best)
  phone              text NOT NULL,
  phone_e164         text GENERATED ALWAYS AS (normalize_phone(phone)) STORED,
  last_deposit_at    timestamptz,
  min_deposit_rupees integer NOT NULL DEFAULT 300,
  is_active          boolean NOT NULL DEFAULT true,
  do_not_call        boolean NOT NULL DEFAULT false,
  language           text NOT NULL DEFAULT 'hi',
  source             text NOT NULL DEFAULT 'manual',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- purane DB pe bhi chal jaaye
ALTER TABLE ivr_customers ADD COLUMN IF NOT EXISTS name_hi text;

CREATE INDEX IF NOT EXISTS ivr_customers_lastdep_idx
  ON ivr_customers (last_deposit_at);

-- ---------------------------------------------------------------------
-- 3. Callable view — worker SIRF isi view se padhta hai.
--
--    Retention ka data kisi doosre table me hai? Bas is view ka body
--    badal do, baaki poora system waisa hi chalega:
--
--    CREATE OR REPLACE VIEW ivr_callable_customers AS
--    SELECT client_id::text      AS customer_key,
--           client_name          AS name,
--           mobile_no            AS phone,
--           last_deposit_on      AS last_deposit_at,
--           300                  AS min_deposit_rupees,
--           (status = 'ACTIVE')  AS is_active,
--           COALESCE(dnc, false) AS do_not_call,
--           'hi'                 AS language
--    FROM   public.retention_clients;
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS ivr_callable_customers;

CREATE OR REPLACE VIEW ivr_callable_customers AS
SELECT
  c.customer_key,
  c.name,
  c.name_hi,
  COALESCE(c.name_hi, c.name)                      AS name_tts,
  c.phone,
  COALESCE(c.phone_e164, normalize_phone(c.phone)) AS phone_e164,
  COALESCE(c.last_deposit_at, c.created_at)        AS last_deposit_at,
  c.min_deposit_rupees,
  c.is_active,
  c.do_not_call,
  c.language
FROM ivr_customers c;

-- ---------------------------------------------------------------------
-- 4. Call jobs — ek customer ka ek hafte me ek row
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_jobs (
  id               bigserial PRIMARY KEY,
  customer_key     text NOT NULL REFERENCES ivr_customers(customer_key) ON DELETE CASCADE,
  name             text NOT NULL,
  phone            text NOT NULL,
  reason           text NOT NULL DEFAULT 'no_deposit_7d',
  cycle_key        text NOT NULL,
  attempt          integer NOT NULL DEFAULT 1,
  status           text NOT NULL DEFAULT 'pending',
  provider         text NOT NULL DEFAULT 'exotel',
  provider_call_sid text,
  duration_sec     integer,
  recording_url    text,
  digits           text,
  disposition      text,
  error            text,
  called_at        timestamptz,
  next_attempt_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- yahi index double-call roktа hai
CREATE UNIQUE INDEX IF NOT EXISTS call_jobs_cycle_uq
  ON call_jobs (customer_key, reason, cycle_key);

CREATE INDEX IF NOT EXISTS call_jobs_status_idx
  ON call_jobs (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS call_jobs_created_idx
  ON call_jobs (created_at DESC);

-- ---------------------------------------------------------------------
-- 5. Raw provider payloads — debugging ka jaan
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_events (
  id                 bigserial PRIMARY KEY,
  provider_call_sid  text NOT NULL DEFAULT '',
  job_id             bigint,
  kind               text NOT NULL,          -- status | dtmf | passthru
  step               text NOT NULL DEFAULT '',
  digits             text,
  payload            jsonb NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now()
);

-- provider ek hi event 3 baar bhej de to bhi ek hi row
CREATE UNIQUE INDEX IF NOT EXISTS call_events_uq
  ON call_events (provider_call_sid, kind, step);

CREATE INDEX IF NOT EXISTS call_events_job_idx
  ON call_events (job_id);

-- ---------------------------------------------------------------------
-- 6. Retention sync log — kaunsa CSV kab aaya, kitne rows
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS retention_syncs (
  id           bigserial PRIMARY KEY,
  filename     text,
  rows_in      integer NOT NULL DEFAULT 0,
  rows_ok      integer NOT NULL DEFAULT 0,
  rows_bad     integer NOT NULL DEFAULT 0,
  bad_reasons  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMIT;





