# dp7-ivr — 7 din no-deposit auto calling

Jin customers ne **7 din** se deposit nahi kiya, unko Exotel ke through
**Hindi AI voice** me auto call jaati hai. Call ka status, duration, recording,
button press — sab **apne aap DB me** update hota hai.

**Data source: DP7 ka `public.deposits`** — jahan roz ka Excel `+ Add Data` se
jaata hai. Alag upload nahi, ek hi jagah.

```
DP7 (+ Add Data)  →  public.deposits  →  ivr_callable_customers (view)
                                              ↓
                          worker: roz 9:30 PM IST pe eligible list
                                              ↓
                          Exotel Connect API → Hindi IVR call
                                              ↓
                          webhook → call_jobs (auto update)
                                              ↓
                          na uthaya → agle din phir (max 3 attempt)
```

---

## 1. IVR keys (client ne yahi chuna)

| Key | Kya hota hai | DB me `disposition` |
|---|---|---|
| **1** | website link **WhatsApp + SMS** pe queue | `link_sent` |
| **2** | **naya ID** banao aur bhejo | `id_created` |
| **3** | **agent** se transfer | `interested` |
| **9** | aage call band (**DND**) | `opted_out` |

`/ivr/settings` page me yeh sab (aur agent number, ₹300, 7 din, call window)
badal sakte ho — **redeploy ki zaroorat nahi**.

---

## 2. Deploy — 2 services

Dono same repo se, dono pe **wahi variables** (`.env.example`).

### Service 1 — web

| Setting | Value |
|---|---|
| Start Command | `npm start` |
| Healthcheck Path | `/api/health` |

### Service 2 — worker

| Setting | Value |
|---|---|
| Start Command | `node src/ivr/worker.js` |
| Domain | **generate mat karo** |

**Migration khud chalti hai** (`src/lib/autoMigrate.js`, boot pe). Railway ka
Pre-Deploy Command set karne ki zaroorat nahi — wo har deploy pe nahi chalta.

### Deploy ke baad yeh check karo

```
https://<domain>/api/ivr/setup
```

Sab `ok: true` hona chahiye: db, view_rows, settings, callable_now.

---

## 3. Agent number badalna

```
https://<domain>/ivr/settings
```

`IVR_ADMIN_TOKEN` daalo → form → Save. **Agli call se naya number** (worker
30 second me uthata hai).

> **Ek baar ka kaam:** Exotel **App Bazaar → Connect applet** me bhi wahi
> number daalna padega — transfer Exotel karta hai, hamara code nahi.

---

## 4. View — kaunsi row kya hai

`ivr_callable_customers` (DP7 ke `public.deposits` se):

| View column | Kahaan se |
|---|---|
| `customer_key` | `deposits.username` — ek user = ek call |
| `phone_e164` | `normalize_phone(deposits.mobile)` |
| `last_deposit_at` | **MAX(play_date)** — sabse aakhri deposit |
| `deposit_count` | us user ke total deposit |
| `total_deposited_rupees` | SUM(amount) |
| `is_active` | `true` — DP7 ka "Inactive" ka matlab account band nahi |

**Important:** `phone` sabse aakhri deposit row se aata hai (`DISTINCT ON`),
taaki purana number use na ho.

Agar DP7 me `public.deposits` na ho (fresh install), view khud fallback kar
leti hai IVR ke apne `ivr_deposits` table pe — app kabhi nahi tooti.

---

## 5. Testing

```bash
npm install
export DATABASE_URL=postgresql://...
npm test          # 75 checks, Exotel ki zaroorat nahi
```

Test khud ek `public.deposits` table banata hai (DP7 jaisa), migration chalata
hai, mock Exotel pe call karta hai, chaaron DTMF keys dabata hai, webhook
simulate karta hai aur sab assert karta hai.

**Asli result: 75 pass / 0 fail** (Postgres 17 pe verify kiya).

Live order:

1. `DRY_RUN=true` → Deploy Logs me `worker.started` + `dry_run.would_call`
2. Test karna ho to `NO_DEPOSIT_DAYS=1` (baad me `7` wapas)
3. `DRY_RUN=false`, `EXOTEL_MOCK=0` → apne number pe ek call
4. `1` / `2` / `3` / `9` — chaaron dabao, DB me disposition dekho

```sql
SELECT id, customer_key, status, disposition, digits, duration_sec
FROM call_jobs ORDER BY id DESC LIMIT 10;

SELECT * FROM call_events ORDER BY id DESC LIMIT 5;   -- raw payload
SELECT * FROM ivr_messages WHERE status='queued';      -- WhatsApp/SMS queue
```

### ⚠️ Exotel field names

Code `CallSid`, `Status`, `Duration`, `RecordingUrl`, `Digits` maan ke chalta
hai (kuch aliases ka fallback bhi). **Pehli asli call ke baad `call_events` ka
raw payload dekh lo.** Naam alag hua to sirf `src/ivr/exotel.js` ka `pick()` /
`mapStatus()` badalna hoga.

---

## 6. Endpoints

| Method | Path | Kaam |
|---|---|---|
| GET | `/api/ivr/setup` | **sab kuch theek hai?** (db, view, settings) |
| GET | `/ivr/settings` | settings page |
| POST | `/api/ivr/webhook?token=` | Exotel status callback (turant 200) |
| POST | `/api/ivr/event?step=digit1` | applet branch → DTMF (text bhi return) |
| POST | `/api/ivr/passthru?token=` | per-customer Hindi text |
| GET/PUT | `/api/ivr/settings` | settings padho / badlo |
| GET | `/api/ivr/jobs?status=` | call log |
| GET | `/api/ivr/stats` | counts |
| GET | `/api/ivr/messages` | WhatsApp/SMS outbox |
| GET | `/api/ivr/deposits?username=` | ek user ka hisaab + days_since |
| POST | `/api/ivr/jobs/:id/recall` | manual dobara call |
| GET | `/api/health` | Railway health check |

Admin header: `x-admin-token: <IVR_ADMIN_TOKEN>`.

---

## 7. Status / disposition

| status | matlab |
|---|---|
| `pending` | queue me |
| `calling` | dial ho gaya |
| `completed` | call hui |
| `no_answer` / `busy` | nahi uthaya → retry |
| `failed` | provider error → retry |

| disposition | matlab |
|---|---|
| `link_sent` | 1 dabaya — link queue me |
| `id_created` | 2 dabaya — naya ID bana |
| `interested` | 3 dabaya — agent chahiye |
| `opted_out` | 9 dabaya — DND |
| `informed` | sun liya, kuch nahi dabaya |
| `exhausted` | 3 attempt ho gaye |

---

## 8. Sabse zyada hoti galtiyan

| Problem | Wajah | Fix |
|---|---|---|
| Worker crash loop | variables us card pe nahi | dono service pe wahi 16 variables |
| `DATABASE_URL` resolve nahi | reference pill | literal URL paste karo |
| Call raat ko | window set nahi | settings → call window 10–21 |
| Agent tak call nahi | settings badla, Exotel applet nahi | dono jagah same number |
| `1` dabane pe kuch nahi | Gather timeout chhota | 8 sec |
| Number block | press 9 honour nahi hua | `/event` route hataana mat |

---

## 9. Cost ka andaaza

500 calls/din × ~40 sec ≈ **₹500–1,000/din** (Exotel plan pe depend).
Script 40 second pe rakho — har extra 10 sec pe ~25% paisa.

