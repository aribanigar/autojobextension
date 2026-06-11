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
