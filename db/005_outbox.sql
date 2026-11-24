-- =====================================================================
--  005 — Outbox: WhatsApp + SMS messages ka queue
--
--  Abhi koi provider connect nahi hai. To jis customer ne 1 (link) ya
--  2 (naya ID) dabaya, uska message yahan queue me baithta hai.
--  Provider lagne pe bas yeh table uthana hai — kuch aur nahi badalna.
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS ivr_messages (
  id            bigserial PRIMARY KEY,
  job_id        bigint,
  customer_key  text,
  to_phone      text NOT NULL,
  channel       text NOT NULL,                 -- whatsapp | sms
  template      text NOT NULL,                 -- website_link | new_id | dnd_ack
  body          text,
  status        text NOT NULL DEFAULT 'queued', -- queued | sent | failed
  provider_ref  text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);

CREATE INDEX IF NOT EXISTS ivr_messages_status_idx
  ON ivr_messages (status, created_at);

-- ek call pe ek hi link message (duplicate webhook se bachne ke liye)
-- NOTE: partial index nahi — warna ON CONFLICT (job_id, channel, template)
-- ko matching constraint nahi milta aur insert fail ho jaata hai.
CREATE UNIQUE INDEX IF NOT EXISTS ivr_messages_once_uq
  ON ivr_messages (job_id, channel, template);

-- digit 2 dabane pe jo naya ID bana, wo call ke saath yaad rahe
ALTER TABLE call_jobs ADD COLUMN IF NOT EXISTS new_id text;

-- website ka link settings me (WhatsApp/SMS me yahi jaata hai)
INSERT INTO ivr_settings (key, value, updated_by) VALUES
  ('website_link', 'https://dailyplay7.com', 'seed')
ON CONFLICT (key) DO NOTHING;

COMMIT;



