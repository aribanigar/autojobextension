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

-- Plans the admin creates in the admin panel. price_paise is in paise (₹1 = 100).
-- interval 'once' = lifetime one-time purchase; 'monthly' = Razorpay subscription.
-- features is a free-form JSON map of feature-flags the admin can toggle per plan.
create table if not exists plans (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  description      text,
  price_paise      integer not null default 0,
  interval         text not null default 'once',    -- once | monthly
  razorpay_plan_id text,                             -- set for monthly plans
  features         jsonb not null default '{}'::jsonb,
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);
alter table plans enable row level security;

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
