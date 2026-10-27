-- Apply once as the postgres role, after 202610270002_rich_messaging.sql.
begin;

create table public.notification_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  in_app_enabled boolean not null default true,
  browser_enabled boolean not null default false,
  sound_enabled boolean not null default false,
  messages_enabled boolean not null default true,
  invitations_enabled boolean not null default true,
  preview_enabled boolean not null default false,
  while_open_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;
revoke all privileges on table public.notification_preferences from public, anon, authenticated;
grant select, insert, update on table public.notification_preferences to authenticated;

create policy "Users manage their own notification preferences"
  on public.notification_preferences for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create table public.notification_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  actor_id uuid not null references auth.users (id) on delete cascade,
  actor_username text not null,
  actor_display_name text,
  type text not null check (type in ('message', 'invitation', 'invitation_accepted')),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  message_id uuid references public.messages (id) on delete cascade,
  invitation_id uuid references public.private_conversation_invitations (id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  push_sent_at timestamptz,
  constraint notification_events_source_check check (
    (type = 'message' and message_id is not null and invitation_id is null)
    or (type in ('invitation', 'invitation_accepted') and message_id is null and invitation_id is not null)
  )
);

create index notification_events_recipient_created_idx
  on public.notification_events (recipient_id, created_at desc);
create index notification_events_unread_idx
  on public.notification_events (recipient_id, created_at desc)
  where read_at is null;
create index notification_events_message_idx
  on public.notification_events (message_id)
  where message_id is not null;
create index notification_events_invitation_idx
  on public.notification_events (invitation_id, type, created_at desc)
  where invitation_id is not null;

alter table public.notification_events enable row level security;
revoke all privileges on table public.notification_events from public, anon, authenticated;
grant select on table public.notification_events to authenticated;
grant update (read_at) on table public.notification_events to authenticated;
grant select on table public.notification_events to service_role;
grant update (push_sent_at) on table public.notification_events to service_role;

create policy "Users read their own notification events"
  on public.notification_events for select to authenticated
  using (recipient_id = (select auth.uid()));

create policy "Users mark their own notifications read"
  on public.notification_events for update to authenticated
  using (recipient_id = (select auth.uid()))
  with check (recipient_id = (select auth.uid()) and read_at is not null);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_subscriptions_endpoint_check check (
    length(endpoint) between 1 and 2048
    and endpoint ~ '^https://'
  ),
  constraint push_subscriptions_keys_check check (
    length(p256dh) between 1 and 256
    and length(auth) between 1 and 256
  )
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
revoke all privileges on table public.push_subscriptions from public, anon, authenticated;
grant select, delete on table public.push_subscriptions to authenticated;
grant select, insert, update, delete on table public.push_subscriptions to service_role;
grant select on table public.notification_preferences to service_role;

create policy "Users read their own push subscriptions"
  on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users remove their own push subscriptions"
  on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()));

create index message_receipts_unread_recipient_idx
  on public.message_receipts (recipient_id, message_id)
  where status = 'delivered';

create function public.list_private_conversation_unread_counts()
returns table (conversation_id uuid, unread_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select m.conversation_id, pg_catalog.count(*)
  from public.message_receipts r
  join public.messages m on m.id = r.message_id
  where r.recipient_id = (select auth.uid())
    and r.status = 'delivered'
    and m.sender_id <> (select auth.uid())
    and public.can_access_private_conversation(m.conversation_id)
  group by m.conversation_id;
$$;

alter function public.list_private_conversation_unread_counts() owner to postgres;
revoke all on function public.list_private_conversation_unread_counts() from public, anon, authenticated;
grant execute on function public.list_private_conversation_unread_counts() to authenticated;

create function public.create_message_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notification_events (
    event_key, recipient_id, actor_id, actor_username, actor_display_name,
    type, conversation_id, message_id
  )
  select
    'message:' || new.id::text || ':' || cm.user_id::text,
    cm.user_id,
    new.sender_id,
    coalesce(p.username, 'user'),
    p.display_name,
    'message',
    new.conversation_id,
    new.id
  from public.conversation_members cm
  join public.profiles p on p.id = new.sender_id
  where cm.conversation_id = new.conversation_id
    and cm.user_id <> new.sender_id
    and public.can_access_private_conversation(new.conversation_id)
  on conflict (event_key) do nothing;
  return new;
end;
$$;

alter function public.create_message_notification() owner to postgres;
revoke all on function public.create_message_notification() from public, anon, authenticated;

create trigger messages_create_notification
  after insert on public.messages
  for each row execute function public.create_message_notification();

create function public.create_invitation_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_recipient_id uuid;
  v_actor_username text;
  v_actor_display_name text;
  v_type text;
  v_event_key text;
begin
  if new.status = 'pending' then
    if tg_op = 'UPDATE' then
      if old.status = new.status then return new; end if;
    end if;
    v_actor_id := new.inviter_id;
    v_recipient_id := new.recipient_id;
    v_type := 'invitation';
    v_event_key := 'invitation:' || new.id::text || ':' || new.created_at::text;
  elsif new.status = 'accepted' then
    if tg_op = 'UPDATE' then
      if old.status = new.status then return new; end if;
    end if;
    v_actor_id := new.recipient_id;
    v_recipient_id := new.inviter_id;
    v_type := 'invitation_accepted';
    v_event_key := 'invitation_accepted:' || new.id::text || ':' || new.responded_at::text;
  else
    return new;
  end if;

  select p.username, p.display_name
    into v_actor_username, v_actor_display_name
  from public.profiles p
  where p.id = v_actor_id;

  insert into public.notification_events (
    event_key, recipient_id, actor_id, actor_username, actor_display_name,
    type, conversation_id, invitation_id
  )
  values (
    v_event_key, v_recipient_id, v_actor_id, coalesce(v_actor_username, 'user'),
    v_actor_display_name, v_type, new.conversation_id, new.id
  )
  on conflict (event_key) do nothing;
  return new;
end;
$$;

alter function public.create_invitation_notification() owner to postgres;
revoke all on function public.create_invitation_notification() from public, anon, authenticated;

create trigger invitations_create_notification
  after insert on public.private_conversation_invitations
  for each row execute function public.create_invitation_notification();

create trigger invitation_status_create_notification
  after update of status on public.private_conversation_invitations
  for each row execute function public.create_invitation_notification();

create or replace function public.mark_private_conversation_read(p_conversation_id uuid)
returns table (message_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null
    or not public.can_access_private_conversation(p_conversation_id) then
    raise exception 'Private conversation access is required to mark messages read.'
      using errcode = '42501';
  end if;

  update public.notification_events n
  set read_at = pg_catalog.now()
  where n.recipient_id = v_user_id
    and n.conversation_id = p_conversation_id
    and n.type = 'message'
    and n.read_at is null;

  return query
  update public.message_receipts r
  set status = 'read'
  from public.messages m
  where r.message_id = m.id
    and m.conversation_id = p_conversation_id
    and m.sender_id <> v_user_id
    and r.recipient_id = v_user_id
    and r.status = 'delivered'
  returning r.message_id;
end;
$$;

insert into public.notification_events (
  event_key, recipient_id, actor_id, actor_username, actor_display_name,
  type, conversation_id, invitation_id, created_at
)
select
  'invitation:' || i.id::text || ':' || i.created_at::text,
  i.recipient_id,
  i.inviter_id,
  coalesce(p.username, 'user'),
  p.display_name,
  'invitation',
  i.conversation_id,
  i.id,
  i.created_at
from public.private_conversation_invitations i
join public.profiles p on p.id = i.inviter_id
where i.status = 'pending'
on conflict (event_key) do nothing;

commit;
