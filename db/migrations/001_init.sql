create table panels (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  locked      boolean not null default false,
  seed_key    text unique,
  created_at  timestamptz not null default now()
);

create table revisions (
  id          uuid primary key default gen_random_uuid(),
  panel_id    uuid not null references panels(id) on delete cascade,
  rev         int not null,
  spec        json not null,   -- json, not jsonb: keeps the author's key order for the spec editor
  steps       jsonb not null,
  status      text not null check (status in ('draft', 'released')),
  created_at  timestamptz not null default now(),
  released_at timestamptz,
  unique (panel_id, rev)
);
-- At most one draft per panel, enforced by the database rather than by a read-then-write.
create unique index one_draft_per_panel on revisions (panel_id) where status = 'draft';

create table runs (
  id           uuid primary key default gen_random_uuid(),
  revision_id  uuid not null references revisions(id) on delete cascade,
  status       text not null check (status in ('running', 'faulted', 'complete', 'aborted')),
  current_step int not null default 0,
  speed        real not null default 1,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
-- One cell: at most one unfinished run per revision.
create unique index one_open_run_per_revision on runs (revision_id) where status in ('running', 'faulted');

create table run_events (
  id      bigserial primary key,
  run_id  uuid not null references runs(id) on delete cascade,
  kind    text not null,
  step    int,
  detail  jsonb not null default '{}',
  at      timestamptz not null default now()
);
create index run_events_by_run on run_events (run_id, id);
