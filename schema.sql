-- JobBot CRM schema – run this once in Supabase: SQL Editor → New query → paste → Run
create table if not exists jobs (
  id         uuid primary key default gen_random_uuid(),
  platform   text not null,                       -- linkedin | indeed | naukri
  title      text,
  company    text,
  url        text,
  status     text not null default 'applied',     -- applied | skipped | interview | offer | rejected
  fit_score  int,                                 -- 0-100, set by /api/ai kind=fit
  notes      text,
  applied_at timestamptz not null default now()
);

create index if not exists jobs_applied_at_idx on jobs (applied_at desc);
create index if not exists jobs_status_idx     on jobs (status);

-- The API uses the service_role key (bypasses RLS), but enable RLS so the
-- anon key can't read anything if it ever leaks.
alter table jobs enable row level security;

-- ── Email/password accounts ──────────────────────────────────────────────────
-- Run this block too (safe to re-run). Each job row is owned by the email of
-- the account that created it, so every user only sees their own data.
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text not null,           -- scrypt, salt:hash (set by /api/auth)
  token         text,                    -- current session bearer token
  created_at    timestamptz not null default now()
);
alter table users enable row level security;

alter table jobs add column if not exists user_email text;
create index if not exists jobs_user_email_idx on jobs (user_email);

-- ════════════════════════════════════════════════════════════════════════════
-- PAYMENTS / LICENSING (Razorpay)  — run this block too (safe to re-run)
-- ════════════════════════════════════════════════════════════════════════════

-- Admin flag. The account whose email matches the ADMIN_EMAIL env var is always
-- treated as admin even without this flag; use this column to grant others.
alter table users add column if not exists is_admin boolean not null default false;

-- Password-reset (forgot-password email flow): a one-time token + its expiry.
alter table users add column if not exists reset_token   text;
alter table users add column if not exists reset_expires timestamptz;

-- Plans the admin creates in the admin panel. price_paise is in paise (₹1 = 100).
-- interval 'once' = lifetime one-time purchase; 'monthly' = Razorpay subscription.
-- features is a free-form JSON map of feature-flags the admin can toggle per plan.
create table if not exists plans (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  description      text,
  price_paise      integer not null default 0,
  interval         text not null default 'once',    -- once | monthly
  duration_days    integer,                          -- one-time validity; null/0 = lifetime
  razorpay_plan_id text,                             -- set for monthly plans
  features         jsonb not null default '{}'::jsonb,
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);
alter table plans enable row level security;

-- Add duration to existing installs (safe to re-run)
alter table plans add column if not exists duration_days integer;

-- One row per checkout attempt / active licence. status drives access:
--   created  → order/subscription made, not paid yet
--   paid     → one-time payment captured (lifetime access)
--   active   → subscription active (access until expires_at)
--   expired  → subscription lapsed / lifetime revoked
--   cancelled→ refunded or cancelled by admin
create table if not exists purchases (
  id                       uuid primary key default gen_random_uuid(),
  user_email               text not null,
  plan_id                  uuid references plans(id),
  interval                 text not null default 'once',
  amount_paise             integer not null default 0,
  status                   text not null default 'created',
  razorpay_order_id        text,
  razorpay_payment_id      text,
  razorpay_subscription_id text,
  starts_at                timestamptz,
  expires_at               timestamptz,             -- null = lifetime
  created_at               timestamptz not null default now()
);
alter table purchases enable row level security;
create index if not exists purchases_user_idx  on purchases (user_email);
create index if not exists purchases_order_idx on purchases (razorpay_order_id);
create index if not exists purchases_sub_idx   on purchases (razorpay_subscription_id);
create index if not exists purchases_status_idx on purchases (status);

-- ── License keys (admin-issued, key-based access) ────────────────────────────
-- The admin generates a key with a validity window. On first use the key
-- activates (expires_at = now + validity_days); after that it's time-limited.
-- The same key runs the extension AND logs into the CRM.
create table if not exists license_keys (
  id            uuid primary key default gen_random_uuid(),
  key           text unique not null,
  validity_days integer not null default 30,
  label         text,                                  -- who it's for / notes
  status        text not null default 'active',        -- active | revoked
  activated_at  timestamptz,                           -- set on first validation
  expires_at    timestamptz,                           -- set on first validation
  created_at    timestamptz not null default now()
);
alter table license_keys enable row level security;
create index if not exists license_keys_key_idx on license_keys (key);

-- CRM rows can be owned by a license key (not just an email account).
alter table jobs add column if not exists license_key text;
create index if not exists jobs_license_key_idx on jobs (license_key);

-- ── Referrals / discount codes ───────────────────────────────────────────────
-- A code gives the BUYER a discount and its owner (the referrer) a reward of
-- reward_days free access per successful purchase. owner_email is null for
-- pure admin promo codes (discount only, no referrer to reward).
create table if not exists coupons (
  id             uuid primary key default gen_random_uuid(),
  code           text unique not null,
  owner_email    text,                                   -- referrer, null = admin promo
  discount_type  text not null default 'percent',        -- percent | flat
  discount_value integer not null default 0,             -- percent (0-100) or paise (flat)
  reward_days    integer not null default 0,             -- days credited to referrer per use
  max_uses       integer,                                -- null = unlimited
  used_count     integer not null default 0,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
alter table coupons enable row level security;
create index if not exists coupons_owner_idx on coupons (owner_email);

-- Track which code/referrer each purchase used, and whether the referrer has
-- already been rewarded for it (idempotency across verify + webhook).
alter table purchases add column if not exists coupon_code    text;
alter table purchases add column if not exists referrer_email text;
alter table purchases add column if not exists discount_paise integer not null default 0;
alter table purchases add column if not exists rewarded       boolean not null default false;
alter table purchases add column if not exists duration_days  integer;   -- validity window for this purchase
