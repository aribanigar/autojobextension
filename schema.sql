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
