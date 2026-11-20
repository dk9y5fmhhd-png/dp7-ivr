# dp7 — Retention IVR (7 din no-deposit auto calling)

Jin customers ne **7 din** se deposit nahi kiya, unko Exotel ke through
**Hindi AI voice** me auto call jaati hai. Call ka status, duration, recording,
button press — sab **apne aap DB me** update hota hai.

**Company: dp7** · **Minimum deposit: ₹300** · **Agent number: settings page se badlo**

```
Retention data (CSV upload  +  SQL view — dono chalte hain)
        ↓
Worker: roz CAMPAIGN_CRON pe eligible customers chunta hai
        ↓
call_jobs (ek customer = ek hafte me ek call)
        ↓
Rate limit + call window (10:00–21:00 IST) ke saath Exotel Connect API
        ↓
Hindi IVR: 1 = agent | 2 = dobara | 3 = WhatsApp link | 9 = opt-out
        ↓
Exotel webhook -> /api/ivr/webhook -> DB turant update
        ↓
Na uthaya / busy -> agle din phir (max 3 attempt)
```

---

## 1. Agent number badalna — sabse pehle yeh padho

**Redeploy ki zaroorat nahi.** Settings DB me rehti hai, isliye:

```
https://<tumhara-service>.up.railway.app/ivr/settings
```

Admin token (`IVR_ADMIN_TOKEN`) daalo → **Agent ka number** badlo → Save.
**Agli call se naya number lagu** ho jaata hai (worker 30 sec ke andar uthata hai).

Isi page se yeh sab badal sakte ho — bina code chhue:

| Setting | Kaam |
|---|---|
| **Agent ka number** | `1` dabane pe call kahan transfer hogi |
| Support number | jo script me bola jaata hai |
| Company naam | `dp7` (script me bolta hai) |
| WhatsApp link | `3` dabane pe bhejna hai |
| Minimum deposit | ₹300 |
| Kitne din bina deposit | 7 |
| Max attempts | 3 |
| Call window | 10 se 21 IST — is beech hi call jaati hai |

API se bhi kar sakte ho:

```bash
curl -X PUT "$BASE/api/ivr/settings" \
  -H "x-admin-token: $IVR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_number":"9876543210"}'
```

**⚠️ Ek baar ka kaam:** Exotel **App Bazaar → Connect applet** me bhi wahi agent
number daalna padega, kyunki transfer Exotel hi karta hai, hamara code nahi.
Settings page tumhe exact value deta hai — usko wahan paste kar do. Uske baad
jab bhi badloge, dono jagah badalna.

---

## 2. Deposits — roz ka Excel upload (yahi main source hai)

**Asli baat:** ek username ke **kai deposit** aate hain. Isliye deposit ek *event* hai,
customer ka field nahi. `ivr_deposits` table me har deposit ek row hai, aur
"last deposit" `MAX(deposit_at)` se nikalta hai. Call tab jaati hai jab **sabse aakhri**
deposit ke **7 din** ho jaayein.

### 2.1 Roz ka file upload karo

Settings page pe hi box hai: **Daily deposit file upload** → file chuno → Upload.
`.xlsx`, `.xls` aur `.csv` — teeno chalte hain.

Ya CLI se:

```bash
npm run import-deposits -- 20-11-2026.xlsx
```

Ya HTTP se:

```bash
curl -X POST "$BASE/api/ivr/import-deposits?filename=20-11-2026.xlsx" \
  -H "x-admin-token: $IVR_ADMIN_TOKEN" \
  --data-binary @20-11-2026.xlsx
```

**Ek hi file do baar upload kar do to kuch nahi bigdega** — duplicate rows chup-chaap
skip ho jaati hain (`username + date + amount + UTR` pe unique index hai).

### 2.2 File me kaunse columns chahiye

Zaroori sirf do: **username** aur **date**. Baaki optional:

| Column | Ye naam bhi chalte hain | Zaroori? |
|---|---|---|
| `username` | `user_name`, `user`, `login`, `player_id`, `member_id` | **haan** |
| `deposit_date` | `date`, `deposit_at`, `txn_date`, `created_at`, `time` | **haan** |
| `amount` | `deposit_amount`, `amt`, `credit`, `inr` | nahi |
| `utr` | `txn_ref`, `reference`, `transaction_id` | nahi (par ho to best) |
| `phone` | `mobile`, `mobile_no`, `contact` | nahi |
| `name` | `full_name`, `customer_name` | nahi |

**Title rows ki chinta mat karo.** File me upar "Daily Deposit Report" ya date likhi ho,
parser khud pehle 15 rows me asli header dhoondh leta hai. Maine ise test kiya hai —
header row 4 pe hone par bhi sahi padhta hai.

Date ke format: `20/11/2026`, `20-11-2026`, `2026-11-20`,
`20/11/2026 14:30`, aur Excel ka asli date cell — sab chalte hain.

### 2.3 Phone aur naam kahan se

Deposit report me phone nahi hota — sirf username hota hai. Do options:

**A) Deposit file me `phone` column bhi daal do** — ek hi file me sab ho jaayega.
Ye best hai. File me phone ho to customer row usi se ban jaati hai.

**B) Alag customer list upload karo** (username + phone), ek baar ya jab bhi naye user aayein:

```bash
npm run import -- samples/retention-sample.csv
```

Isme `client_id` ki jagah **username** daal do, taaki dono files ki key match kare.

> **Sabse zaroori baat:** `customer_key` **username hi hona chahiye**, internal id nahi.
> Deposit file username se aati hai — agar customer list me `C-5001` hai aur deposit file
> me `rahul9`, to dono kabhi join nahi honge aur koi call nahi jaayegi.
> Jo file phone laati hai, usme username hi key rakho.

### 2.4 Ek user ka hisaab dekho

```bash
curl "$BASE/api/ivr/deposits?username=rahul9" -H "x-admin-token: $IVR_ADMIN_TOKEN"
```

Jawab me uski saari deposit + `last_deposit_at` + `days_since` aata hai.
Isi se dispute solve ho jaata hai ("maine kal deposit kiya tha, call kyun aayi?").

### 2.5 Upload ka record

`/api/ivr/uploads` ya settings page — har file ka: kitne naye, kitne duplicate,
kitne reject, kitne users. Reject hui rows ka reason bhi.

---

## 3. Retention table se seedha (optional, real-time)

Agar chaho ki deposit *turant* pata chale (Excel upload ka intezaar na karo), to apne
deposit table se seedha view bana do. Code me kuch badalna nahi — bas view ka body:

```sql
DROP VIEW IF EXISTS ivr_callable_customers;
CREATE VIEW ivr_callable_customers AS
SELECT c.username::text                                   AS customer_key,
       c.full_name                                        AS name,
       NULL::text                                         AS name_hi,
       c.mobile_no                                        AS phone,
       normalize_phone(c.mobile_no)                       AS phone_e164,
       COALESCE(d.last_deposit, c.created_at)             AS last_deposit_at,
       300                                                AS min_deposit_rupees,
       (c.status = 'ACTIVE')                              AS is_active,
       COALESCE(c.dnc, false)                             AS do_not_call,
       'hi'                                               AS language
FROM public.users c
LEFT JOIN LATERAL (
  SELECT MAX(t.created_at) AS last_deposit
  FROM   public.transactions t
  WHERE  t.user_id = c.id AND t.type = 'DEPOSIT'
) d ON true;
```

`LATERAL` + `MAX()` hi use karo — seedha `JOIN` karoge to ek user 5 baar view me
aa jayega (kyunki 5 deposit hain), aur galat count banega.

Dono ek saath bhi chal sakte hain: Excel se history, view se live last-deposit.


---

## 4. Railway deploy (2 services)

### Service 1 — web

| Setting | Value |
|---|---|
| Start Command | `npm start` |
| **Pre-Deploy Command** | `npm run migrate` |
| Health Check Path | `/api/health` |

### Service 2 — worker

Same repo, naya service:

| Setting | Value |
|---|---|
| Start Command | `node src/ivr/worker.js` |

Dono me same variables (`.env.example` dekho).

Migration Pre-Deploy me hona zaroori hai — tables pehle banenge, phir code chalega.
Worker alag isliye ki web crash ho to calling ruke nahi; aur do instance chal
jaayein to `pg_advisory_lock` ki wajah se sirf ek dial karega.

---

## 5. Exotel applet wiring

Caller ID = `EXOTEL_CALLER_ID` (customer ko yeh dikhega),
To = `EXOTEL_FLOW_NUMBER` (IVR app isi number pe laga hai).

| # | Applet | Setting |
|---|---|---|
| 1 | Passthru | `POST /api/ivr/passthru?token=...` → Hindi text → Play |
| 2 | Gather | max 1 digit, timeout 8 sec |
| 3 | Branch 1 | `POST /api/ivr/event?step=digit1` → **Connect** (agent number) |
| 4 | Branch 2 | wapas applet 1 (sirf ek baar) |
| 5 | Branch 3 | `POST /api/ivr/event?step=digit3` → WhatsApp/SMS → Hangup |
| 6 | Branch 9 | `POST /api/ivr/event?step=digit9` → opt-out text → Hangup |
| 7 | No input | prompt → Hangup |

Applet timeout **2-3 sec** aur "continue immediately" — customer ko rukna nahi chahiye.

**Zaroori:** Exotel ka StatusCallback sirf final status deta hai
(completed / no-answer / busy) — **DTMF digit wahan nahi aata**. Digit applet
branch se `/api/ivr/event` pe aata hai. Isliye dono routes hain.

---

## 6. Testing

```bash
npm install
export DATABASE_URL=postgresql://...
npm run migrate
npm run seed      # 8 demo customers
npm test          # 75 checks, Exotel ki zaroorat nahi
```

`npm test` do suites chalata hai (122 checks total, Exotel ki zaroorat nahi):

| Suite | Kya check hota hai |
|---|---|
| `test/e2e.test.js` (75) | campaign filter, dedupe, retry cap, press 9 → DNC, settings/agent number, call window, HTTP tokens, advisory lock, cron matcher |
| `test/deposits.test.js` (47) | XLSX + CSV parse, title rows skip, ek user ke 3 deposit, MAX() se last deposit, duplicate upload, 7-din gate ke saare cases, galat file handling |

**Asli result:** `75 + 47 = 122 pass / 0 fail` (Postgres 17 pe verify kiya).

### Live testing order

1. `DRY_RUN=true` → worker chalao → log me `dry_run.would_call` (agent number bhi dikhta hai)
2. `DRY_RUN=false`, `EXOTEL_MOCK=0` → apne number pe ek call
3. `1` dabao → agent ka phone baja? `3` → `whatsapp_sent`? `9` → `do_not_call=true`?
4. Kuch na dabao → 8 sec baad repeat, phir hangup?
5. `call_events` table me raw payload aaya?

```sql
SELECT provider_call_sid, kind, step, digits, payload
FROM call_events ORDER BY id DESC LIMIT 5;
```

### ⚠️ Honest warning

Exotel ke field names aur passthru ka response shape version ke saath badalte hain.
Code `CallSid`, `Status`, `Duration`, `RecordingUrl`, `Digits` maan ke chalta hai
(kuch aliases ka fallback bhi hai). **Pehli asli call ke baad `call_events` ka raw
payload dekh lo.** Naam alag hua to sirf `src/ivr/exotel.js` ka `pick()` /
`mapStatus()` badalna hoga — baaki system waisa hi chalega.

---

## 7. Endpoints

| Method | Path | Kaam |
|---|---|---|
| GET | `/ivr/settings` | **Settings page — agent number yahan se badlo** |
| POST | `/api/ivr/import-deposits` | **Roz ka Excel/CSV upload** |
| GET | `/api/ivr/deposits?username=` | Ek user ki deposit history + days_since |
| GET | `/api/ivr/uploads` | Upload history (naye / duplicate / reject) |
| POST | `/api/ivr/import` | Customer list (username + phone) |
| POST | `/api/ivr/webhook?token=` | Exotel status callback (turant 200) |
| POST | `/api/ivr/event?step=digit1` | Applet branch → DTMF |
| POST | `/api/ivr/passthru?token=` | Per-customer Hindi text |
| POST | `/api/ivr/import` | CSV upload (admin) |
| GET/PUT | `/api/ivr/settings` | Settings padho / badlo (admin) |
| GET | `/api/ivr/agent` | Sirf agent number |
| GET | `/api/ivr/jobs?status=` | Call log |
| GET | `/api/ivr/stats` | Counts (interested, dnc, avg duration…) |
| GET | `/api/ivr/preview?customer_key=C-5001` | Script preview |
| POST | `/api/ivr/jobs/:id/recall` | Manual dobara call |
| GET | `/api/ivr/syncs` | Retention upload history |
| GET | `/api/health` | Railway health check |

Admin routes pe header: `x-admin-token: <IVR_ADMIN_TOKEN>`.

---

## 8. Status dictionary

| status | matlab |
|---|---|
| `pending` | queue me hai |
| `calling` | dial ho gaya, result ka intezaar |
| `completed` | call hui (disposition dekho) |
| `no_answer` / `busy` | nahi uthaya — retry |
| `failed` | provider error — retry |

| disposition | matlab |
|---|---|
| `interested` | 1 dabaya — agent se baat |
| `whatsapp_sent` | 3 dabaya |
| `opted_out` | 9 dabaya — `do_not_call = true` |
| `informed` | sun liya, kuch nahi dabaya |
| `exhausted` | 3 attempt ho gaye |

---

## 9. Jo galtiyan sabse zyada hoti hain

| Problem | Wajah | Fix |
|---|---|---|
| Dobara call | worker ke 2 instance | advisory lock handle karta hai; worker alag service rakho |
| Call raat ko chali gayi | window set nahi | settings page → call window 10–21 |
| Customer turant cut karta hai | caller ID badal raha | ek hi `EXOTEL_CALLER_ID` |
| Agent tak call nahi pahunchi | settings me number badla, Exotel applet me nahi | dono jagah same number |
| Flow samajh nahi aata | TTS speed 1.0+, pause nahi | speed 0.95, options ke beech 800ms |
| `1` dabane pe kuch nahi | Gather timeout chhota | 8 sec |
| Webhook nahi aa raha | HTTP ya private URL | public HTTPS + turant 200 |
| Number block | press 9 honour nahi hua | `/event` route hataana mat |

---

## 10. Cost ka andaaza

500 calls/din × ~40 sec ≈ **₹500–1,000/din** (Exotel plan pe depend).
Script 40 second pe rakho — har extra 10 sec pe ~25% paisa.



