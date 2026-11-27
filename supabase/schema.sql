create table if not exists public.mypage_workspaces (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{"projects":[],"tasks":[],"games":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.mypage_workspaces enable row level security;

create policy "users can read their own workspace"
  on public.mypage_workspaces for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "users can create their own workspace"
  on public.mypage_workspaces for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "users can update their own workspace"
  on public.mypage_workspaces for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update on public.mypage_workspaces to authenticated;
revoke all on public.mypage_workspaces from anon;
