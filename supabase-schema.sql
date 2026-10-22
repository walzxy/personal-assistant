-- Xiao Yu personal assistant: first cloud persistence layer
-- Run this in Supabase Dashboard > SQL Editor.

create table if not exists public.workspace_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.workspace_state enable row level security;

grant select, insert, update, delete on table public.workspace_state to authenticated;

drop policy if exists "Users can read their own workspace" on public.workspace_state;
create policy "Users can read their own workspace"
  on public.workspace_state for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own workspace" on public.workspace_state;
create policy "Users can create their own workspace"
  on public.workspace_state for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own workspace" on public.workspace_state;
create policy "Users can update their own workspace"
  on public.workspace_state for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own workspace" on public.workspace_state;
create policy "Users can delete their own workspace"
  on public.workspace_state for delete
  to authenticated
  using (auth.uid() = user_id);
