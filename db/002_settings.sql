-- =====================================================================
--  Settings — agent number, company naam, amount: sab DB me
--  Matlab: badalne ke liye redeploy nahi, bas settings page kholo.
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS ivr_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- defaults sirf pehli baar
INSERT INTO ivr_settings (key, value, updated_by) VALUES
  ('company_name',       'dp7',              'seed'),
  ('agent_number',       '+919000000001',    'seed'),
  ('support_number',     '9000000001',       'seed'),
  ('whatsapp_link',      'https://wa.me/919000000001', 'seed'),
  ('min_deposit_rupees', '300',              'seed'),
  ('no_deposit_days',    '7',                'seed'),
  ('max_attempts',       '3',                'seed'),
  ('call_window_start',  '10',               'seed'),  -- 10:00 IST se pehle call nahi
  ('call_window_end',    '21',               'seed')   -- 21:00 IST ke baad call nahi
ON CONFLICT (key) DO NOTHING;

COMMIT;

