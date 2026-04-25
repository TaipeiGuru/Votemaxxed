create table if not exists prompts (
  id bigserial primary key,
  text text not null unique,
  report_count integer not null default 0,
  is_deleted boolean not null default false
);

create index if not exists prompts_active_idx
  on prompts (is_deleted, id);

create table if not exists prompt_reports (
  prompt_id bigint not null references prompts(id) on delete cascade,
  reporter_key text not null,
  created_at timestamptz not null default now(),
  primary key (prompt_id, reporter_key)
);

create index if not exists prompt_reports_prompt_idx
  on prompt_reports (prompt_id);

alter table public.prompts enable row level security;
alter table public.prompt_reports enable row level security;

grant usage on schema public to service_role, authenticated, anon;
grant select, insert, update, delete on table public.prompts to service_role;
grant select, insert, update, delete on table public.prompt_reports to service_role;
grant usage, select on sequence public.prompts_id_seq to service_role;

revoke all on table public.prompts from anon, authenticated;
revoke all on table public.prompt_reports from anon, authenticated;

drop policy if exists prompts_service_role_all on public.prompts;
create policy prompts_service_role_all
on public.prompts
for all
to service_role
using (true)
with check (true);

drop policy if exists prompt_reports_service_role_all on public.prompt_reports;
create policy prompt_reports_service_role_all
on public.prompt_reports
for all
to service_role
using (true)
with check (true);

create or replace function report_prompt(p_prompt_id bigint, p_reporter_key text)
returns table (
  id bigint,
  text text,
  report_count integer,
  is_deleted boolean
)
language plpgsql
as $$
declare
  v_inserted int := 0;
begin
  insert into prompt_reports (prompt_id, reporter_key)
  values (p_prompt_id, p_reporter_key)
  on conflict do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    return;
  end if;

  return query
  update prompts
  set
    report_count = report_count + 1,
    is_deleted = (report_count + 1) >= 5
  where prompts.id = p_prompt_id
    and prompts.is_deleted = false
  returning prompts.id, prompts.text, prompts.report_count, prompts.is_deleted;
end;
$$;

grant execute on function report_prompt(bigint, text) to service_role;
