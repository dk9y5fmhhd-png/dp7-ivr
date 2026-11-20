// Central config — saare env vars ek jagah, start hote hi validate
import process from 'node:process';

const bool = (v, d = false) => {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};

const env = process.env;

export const config = {
  env: env.NODE_ENV ?? 'development',
  port: int(env.PORT, 8080),
  databaseUrl: env.DATABASE_URL ?? '',
  dbSsl: bool(env.DB_SSL, String(env.DATABASE_URL ?? '').includes('railway')),

  // Tenant branding — jaisa customer ko sunai dena hai
  companyName: env.COMPANY_NAME ?? 'Company',
  supportNumber: env.SUPPORT_NUMBER ?? '',
  agentNumber: env.AGENT_NUMBER ?? '',
  whatsappLink: env.WHATSAPP_LINK ?? '',

  // Business rule
  noDepositDays: int(env.NO_DEPOSIT_DAYS, 7),
  minDepositRupees: int(env.MIN_DEPOSIT_RUPEES, 300), // <- 300 default
  maxAttempts: int(env.MAX_ATTEMPTS, 3),
  retryAfterHours: int(env.RETRY_AFTER_HOURS, 24),

  // Worker behaviour
  callsPerMinute: int(env.CALLS_PER_MINUTE, 8),
  pollSeconds: int(env.POLL_SECONDS, 300),
  campaignCron: env.CAMPAIGN_CRON ?? '30 21 * * *', // roz 9:30 PM local
  cronTz: env.CRON_TZ ?? 'Asia/Kolkata',
  callTimeLimitSec: int(env.CALL_TIME_LIMIT_SEC, 90),
  callTimeoutSec: int(env.CALL_TIMEOUT_SEC, 30),
  recordCalls: bool(env.RECORD_CALLS, true),
  dryRun: bool(env.DRY_RUN, false),

  // Retention source
  retentionView: env.RETENTION_VIEW ?? 'ivr_callable_customers',

  // Exotel
  exotel: {
    sid: env.EXOTEL_SID ?? '',
    apiKey: env.EXOTEL_API_KEY ?? '',
    apiToken: env.EXOTEL_API_TOKEN ?? '',
    subdomain: env.EXOTEL_SUBDOMAIN ?? 'api.exotel.com',
    callerId: env.EXOTEL_CALLER_ID ?? '',
    flowNumber: env.EXOTEL_FLOW_NUMBER ?? '',
    mock: bool(env.EXOTEL_MOCK, false),
  },

  tokens: {
    webhook: env.IVR_WEBHOOK_TOKEN ?? '',
    admin: env.IVR_ADMIN_TOKEN ?? '',
  },

  publicBaseUrl: (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, ''),

  advisorLockId: int(env.ADVISOR_LOCK_ID, 8421301),
};

// sirf identifier, kabhi SQL injection nahi
export const safeIdent = (v) => /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(String(v ?? ''));

export function validateConfig({ needExotel = true, needDb = true } = {}) {
  const problems = [];
  if (needDb && !config.databaseUrl) problems.push('DATABASE_URL missing');
  if (!config.tokens.webhook) problems.push('IVR_WEBHOOK_TOKEN missing (webhook bina token ke khula hai)');
  if (needExotel && !config.exotel.mock) {
    for (const k of ['sid', 'apiKey', 'apiToken', 'callerId', 'flowNumber']) {
      if (!config.exotel[k]) problems.push(`EXOTEL_${k.replace(/[A-Z]/g, (m) => '_' + m).toUpperCase()} missing`);
    }
  }
  if (!safeIdent(config.retentionView)) problems.push('RETENTION_VIEW invalid identifier');
  if (config.minDepositRupees <= 0) problems.push('MIN_DEPOSIT_RUPEES must be > 0');
  return problems;
}

export default config;

