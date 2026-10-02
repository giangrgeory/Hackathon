create table if not exists public.community_reports (
    id text primary key,
    name text not null,
    title text not null,
    details text not null default '',
    category text not null,
    latitude text not null,
    longitude text not null,
    photo_name text,
    photo_path text,
    analysis jsonb not null default '{"detections": []}'::jsonb,
    priority text not null default 'medium',
    status text not null default 'Pending',
    created_at timestamptz not null default now(),
    resolved_at timestamptz
);

alter table public.community_reports enable row level security;

grant all on public.community_reports to service_role;

insert into storage.buckets (id, name, public, file_size_limit)
values ('report-photos', 'report-photos', false, 8388608)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;
