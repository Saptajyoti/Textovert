-- Apply once as the postgres role, after 202610270003_notifications.sql.
begin;

alter table public.conversations
  add column description text,
  add column avatar_url text,
  add constraint conversations_group_description_check
    check (description is null or char_length(description) <= 500),
  add constraint conversations_group_avatar_url_check
    check (avatar_url is null or (
      char_length(avatar_url) <= 2048 and avatar_url ~ '^https://'
    ));

create table public.conversation_notification_mutes (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

alter table public.conversation_notification_mutes enable row level security;
revoke all privileges on table public.conversation_notification_mutes from public, anon, authenticated;
grant select, insert, delete on table public.conversation_notification_mutes to authenticated;

create function public.can_access_conversation(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when c.kind = 'private' then public.can_access_private_conversation(c.id)
    when c.kind = 'group' then exists (
      select 1
      from public.conversation_members cm
      where cm.conversation_id = c.id
        and cm.user_id = (select auth.uid())
    )
    else false
  end
  from public.conversations c
  where c.id = p_conversation_id;
$$;

alter function public.can_access_conversation(uuid) owner to postgres;
revoke all on function public.can_access_conversation(uuid) from public, anon, authenticated;
grant execute on function public.can_access_conversation(uuid) to authenticated;

create function public.lookup_group_member(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_profile public.profiles%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_username is null
    or pg_catalog.char_length(pg_catalog.btrim(p_username)) not between 3 and 32
    or pg_catalog.btrim(p_username) !~ '^[A-Za-z0-9_]{3,32}$' then
    raise exception 'Username must be 3 to 32 letters, numbers, or underscores.'
      using errcode = '22023';
  end if;
  if not public.consume_private_username_lookup_quota() then
    return pg_catalog.jsonb_build_object('status', 'rate_limited');
  end if;

  select p.* into v_profile
  from public.profiles p
  where pg_catalog.lower(p.username) = pg_catalog.lower(pg_catalog.btrim(p_username));
  if not found or v_profile.id = v_user_id then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  return pg_catalog.jsonb_build_object(
    'found', true,
    'user_id', v_profile.id,
    'username', v_profile.username,
    'display_name', v_profile.display_name,
    'avatar_url', v_profile.avatar_url
  );
end;
$$;

create policy "Users manage their own group notification mutes"
  on public.conversation_notification_mutes for all to authenticated
  using (
    user_id = (select auth.uid())
    and (select public.can_access_conversation(conversation_id))
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_notification_mutes.conversation_id and c.kind = 'group'
    )
  )
  with check (
    user_id = (select auth.uid())
    and (select public.can_access_conversation(conversation_id))
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_notification_mutes.conversation_id and c.kind = 'group'
    )
  );

drop policy "Conversation members can read message reactions" on public.message_reactions;
drop policy "Users can add their own message reactions" on public.message_reactions;
drop policy "Users can remove their own message reactions" on public.message_reactions;

create policy "Conversation members can read message reactions"
  on public.message_reactions for select to authenticated
  using (exists (
    select 1
    from public.messages m
    where m.id = message_reactions.message_id
      and (select public.can_access_conversation(m.conversation_id))
  ));

create policy "Users can add their own message reactions"
  on public.message_reactions for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.messages m
      where m.id = message_reactions.message_id
        and (select public.can_access_conversation(m.conversation_id))
    )
  );

create policy "Users can remove their own message reactions"
  on public.message_reactions for delete to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.messages m
      where m.id = message_reactions.message_id
        and (select public.can_access_conversation(m.conversation_id))
    )
  );

drop policy "Conversation members can read private conversation media" on storage.objects;
drop policy "Users can remove their own private conversation uploads" on storage.objects;

create policy "Conversation members can read private conversation media"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'conversation-media'
    and array_length(storage.foldername(name), 1) = 2
    and (select public.can_access_conversation(
      ((storage.foldername(name))[1])::uuid
    ))
  );

create policy "Users can remove their own private conversation uploads"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'conversation-media'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and (select public.can_access_conversation(
      ((storage.foldername(name))[1])::uuid
    ))
  );

create policy "Groups must use the group creation workflow"
  on public.conversations as restrictive for insert to authenticated
  with check (kind <> 'group');

create function public.create_group_conversation(
  p_name text,
  p_description text,
  p_avatar_url text,
  p_member_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_conversation_id uuid;
  v_selected_count integer;
  v_profile_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_name is null or pg_catalog.char_length(pg_catalog.btrim(p_name)) not between 1 and 100 then
    raise exception 'Group names must contain 1 to 100 characters.' using errcode = '22023';
  end if;
  if p_description is not null and pg_catalog.char_length(p_description) > 500 then
    raise exception 'Group descriptions cannot exceed 500 characters.' using errcode = '22023';
  end if;
  if p_avatar_url is not null and (
    pg_catalog.char_length(p_avatar_url) > 2048 or p_avatar_url !~ '^https://'
  ) then
    raise exception 'Group avatars must use an HTTPS image URL.' using errcode = '22023';
  end if;
  if p_member_ids is null or pg_catalog.cardinality(p_member_ids) not between 1 and 99
    or array_position(p_member_ids, null) is not null then
    raise exception 'Choose between 1 and 99 existing members.' using errcode = '22023';
  end if;

  select pg_catalog.count(*), pg_catalog.count(distinct selected.user_id)
    into v_selected_count, v_profile_count
  from pg_catalog.unnest(p_member_ids) as selected(user_id);
  if v_selected_count <> v_profile_count
    or v_user_id = any(p_member_ids)
    or (select pg_catalog.count(*) from public.profiles p where p.id = any(p_member_ids))
      <> v_selected_count then
    raise exception 'Member selection must contain distinct existing users other than yourself.'
      using errcode = '22023';
  end if;

  insert into public.conversations (kind, title, description, avatar_url, created_by)
  values ('group', pg_catalog.btrim(p_name), nullif(pg_catalog.btrim(p_description), ''),
    p_avatar_url, v_user_id)
  returning id into v_conversation_id;

  insert into public.conversation_members (conversation_id, user_id, role)
  values (v_conversation_id, v_user_id, 'admin');
  insert into public.conversation_members (conversation_id, user_id, role)
  select v_conversation_id, selected.user_id, 'member'
  from pg_catalog.unnest(p_member_ids) as selected(user_id);

  return v_conversation_id;
end;
$$;

create function public.list_my_group_conversations()
returns table (
  id uuid,
  kind text,
  title text,
  description text,
  avatar_url text,
  created_at timestamptz,
  updated_at timestamptz,
  member_count bigint,
  my_role text,
  muted boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.id,
    c.kind,
    c.title,
    c.description,
    c.avatar_url,
    c.created_at,
    greatest(c.updated_at, coalesce(max(m.created_at), c.created_at)) as updated_at,
    pg_catalog.count(distinct cm.user_id) as member_count,
    mine.role as my_role,
    exists (
      select 1 from public.conversation_notification_mutes mute
      where mute.conversation_id = c.id and mute.user_id = (select auth.uid())
    ) as muted
  from public.conversations c
  join public.conversation_members mine
    on mine.conversation_id = c.id and mine.user_id = (select auth.uid())
  join public.conversation_members cm on cm.conversation_id = c.id
  left join public.messages m on m.conversation_id = c.id
  where c.kind = 'group'
  group by c.id, mine.role
  order by greatest(c.updated_at, coalesce(max(m.created_at), c.created_at)) desc;
$$;

create function public.list_group_conversation_members(p_conversation_id uuid)
returns table (
  user_id uuid,
  username text,
  display_name text,
  avatar_url text,
  role text,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.can_access_conversation(p_conversation_id)
    or not exists (
      select 1 from public.conversations c
      where c.id = p_conversation_id and c.kind = 'group'
    ) then
    raise exception 'Group membership is required.' using errcode = '42501';
  end if;

  return query
  select p.id, p.username, p.display_name, p.avatar_url, cm.role, cm.joined_at
  from public.conversation_members cm
  join public.profiles p on p.id = cm.user_id
  where cm.conversation_id = p_conversation_id
  order by (cm.role = 'admin') desc, cm.joined_at, p.username;
end;
$$;

create function public.update_group_conversation(
  p_conversation_id uuid,
  p_name text,
  p_description text,
  p_avatar_url text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.conversations c
    join public.conversation_members cm on cm.conversation_id = c.id
    where c.id = p_conversation_id and c.kind = 'group'
      and cm.user_id = (select auth.uid()) and cm.role = 'admin'
  ) then
    raise exception 'Group admin access is required.' using errcode = '42501';
  end if;
  if p_name is null or pg_catalog.char_length(pg_catalog.btrim(p_name)) not between 1 and 100
    or (p_description is not null and pg_catalog.char_length(p_description) > 500)
    or (p_avatar_url is not null and (
      pg_catalog.char_length(p_avatar_url) > 2048 or p_avatar_url !~ '^https://'
    )) then
    raise exception 'Group details are invalid.' using errcode = '22023';
  end if;

  update public.conversations
  set title = pg_catalog.btrim(p_name),
      description = nullif(pg_catalog.btrim(p_description), ''),
      avatar_url = p_avatar_url,
      updated_at = pg_catalog.now()
  where id = p_conversation_id and kind = 'group';
end;
$$;

create function public.add_group_conversation_members(
  p_conversation_id uuid,
  p_member_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_selected_count integer;
  v_existing_count integer;
begin
  perform 1 from public.conversations c
  where c.id = p_conversation_id and c.kind = 'group'
  for update;
  if not found or not exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = p_conversation_id
      and cm.user_id = v_user_id and cm.role = 'admin'
  ) then
    raise exception 'Group admin access is required.' using errcode = '42501';
  end if;
  if p_member_ids is null or pg_catalog.cardinality(p_member_ids) not between 1 and 99
    or array_position(p_member_ids, null) is not null then
    raise exception 'Choose between 1 and 99 existing members.' using errcode = '22023';
  end if;

  select pg_catalog.count(*), pg_catalog.count(distinct selected.user_id)
    into v_selected_count, v_existing_count
  from pg_catalog.unnest(p_member_ids) as selected(user_id);
  if v_selected_count <> v_existing_count
    or v_user_id = any(p_member_ids)
    or (select pg_catalog.count(*) from public.profiles p where p.id = any(p_member_ids))
      <> v_selected_count
    or exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = p_conversation_id and cm.user_id = any(p_member_ids)
    ) then
    raise exception 'Member selection must contain distinct existing non-members.'
      using errcode = '22023';
  end if;
  if (select pg_catalog.count(*) from public.conversation_members cm
      where cm.conversation_id = p_conversation_id) + v_selected_count > 100 then
    raise exception 'Groups cannot exceed 100 members.' using errcode = '22023';
  end if;

  insert into public.conversation_members (conversation_id, user_id, role)
  select p_conversation_id, selected.user_id, 'member'
  from pg_catalog.unnest(p_member_ids) as selected(user_id);
  return v_selected_count;
end;
$$;

create function public.remove_group_conversation_member(
  p_conversation_id uuid,
  p_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_target_role text;
  v_admin_count integer;
begin
  perform 1 from public.conversations c
  where c.id = p_conversation_id and c.kind = 'group'
  for update;
  if not found or not exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = p_conversation_id
      and cm.user_id = v_actor_id and cm.role = 'admin'
  ) then
    raise exception 'Group admin access is required.' using errcode = '42501';
  end if;
  if p_member_id is null or p_member_id = v_actor_id then
    raise exception 'Use the leave-group action to remove yourself.' using errcode = '22023';
  end if;

  select cm.role into v_target_role
  from public.conversation_members cm
  where cm.conversation_id = p_conversation_id and cm.user_id = p_member_id;
  if not found then
    raise exception 'Group member not found.' using errcode = '22023';
  end if;
  select pg_catalog.count(*) into v_admin_count
  from public.conversation_members cm
  where cm.conversation_id = p_conversation_id and cm.role = 'admin';
  if v_target_role = 'admin' and v_admin_count <= 1 then
    raise exception 'Promote another admin before removing the last group admin.'
      using errcode = '22023';
  end if;

  delete from public.conversation_members
  where conversation_id = p_conversation_id and user_id = p_member_id;
end;
$$;

create function public.promote_group_conversation_member(
  p_conversation_id uuid,
  p_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.conversations c
  where c.id = p_conversation_id and c.kind = 'group'
  for update;
  if not found or not exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = p_conversation_id
      and cm.user_id = (select auth.uid()) and cm.role = 'admin'
  ) then
    raise exception 'Group admin access is required.' using errcode = '42501';
  end if;
  update public.conversation_members
  set role = 'admin'
  where conversation_id = p_conversation_id and user_id = p_member_id;
  if not found then
    raise exception 'Group member not found.' using errcode = '22023';
  end if;
end;
$$;

create function public.leave_group_conversation(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_role text;
  v_admin_count integer;
  v_next_admin uuid;
begin
  perform 1 from public.conversations c
  where c.id = p_conversation_id and c.kind = 'group'
  for update;
  if not found then
    raise exception 'Group not found.' using errcode = '22023';
  end if;
  select cm.role into v_role
  from public.conversation_members cm
  where cm.conversation_id = p_conversation_id and cm.user_id = v_user_id;
  if not found then
    raise exception 'You are not a group member.' using errcode = '42501';
  end if;

  select pg_catalog.count(*) into v_admin_count
  from public.conversation_members cm
  where cm.conversation_id = p_conversation_id and cm.role = 'admin';
  if v_role = 'admin' and v_admin_count = 1 then
    select cm.user_id into v_next_admin
    from public.conversation_members cm
    where cm.conversation_id = p_conversation_id and cm.user_id <> v_user_id
    order by cm.joined_at, cm.user_id
    limit 1;
    if v_next_admin is null then
      delete from public.conversations where id = p_conversation_id;
      return pg_catalog.jsonb_build_object('status', 'deleted', 'member_ids', '[]'::jsonb);
    end if;
    update public.conversation_members
    set role = 'admin'
    where conversation_id = p_conversation_id and user_id = v_next_admin;
  end if;

  delete from public.conversation_members
  where conversation_id = p_conversation_id and user_id = v_user_id;
  return pg_catalog.jsonb_build_object(
    'status', case when v_role = 'admin' and v_admin_count = 1
      then 'admin_transferred' else 'left' end,
    'member_ids', coalesce((
      select pg_catalog.jsonb_agg(cm.user_id)
      from public.conversation_members cm
      where cm.conversation_id = p_conversation_id
    ), '[]'::jsonb)
  );
end;
$$;

create function public.set_group_conversation_muted(
  p_conversation_id uuid,
  p_muted boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.can_access_conversation(p_conversation_id)
    or not exists (
      select 1 from public.conversations c
      where c.id = p_conversation_id and c.kind = 'group'
    ) then
    raise exception 'Group membership is required.' using errcode = '42501';
  end if;
  if p_muted then
    insert into public.conversation_notification_mutes (conversation_id, user_id)
    values (p_conversation_id, (select auth.uid()))
    on conflict do nothing;
  else
    delete from public.conversation_notification_mutes
    where conversation_id = p_conversation_id and user_id = (select auth.uid());
  end if;
end;
$$;

create or replace function public.list_private_conversation_unread_counts()
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
    and public.can_access_conversation(m.conversation_id)
  group by m.conversation_id;
$$;

create or replace function public.create_message_notification()
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
    and public.can_access_conversation(new.conversation_id)
    and not exists (
      select 1 from public.conversation_notification_mutes mute
      where mute.conversation_id = new.conversation_id and mute.user_id = cm.user_id
    )
  on conflict (event_key) do nothing;
  return new;
end;
$$;

create or replace function public.mark_private_conversation_read(p_conversation_id uuid)
returns table (message_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null or not public.can_access_conversation(p_conversation_id) then
    raise exception 'Conversation access is required to mark messages read.'
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

alter function public.create_group_conversation(text, text, text, uuid[]) owner to postgres;
alter function public.lookup_group_member(text) owner to postgres;
alter function public.list_my_group_conversations() owner to postgres;
alter function public.list_group_conversation_members(uuid) owner to postgres;
alter function public.update_group_conversation(uuid, text, text, text) owner to postgres;
alter function public.add_group_conversation_members(uuid, uuid[]) owner to postgres;
alter function public.remove_group_conversation_member(uuid, uuid) owner to postgres;
alter function public.promote_group_conversation_member(uuid, uuid) owner to postgres;
alter function public.leave_group_conversation(uuid) owner to postgres;
alter function public.set_group_conversation_muted(uuid, boolean) owner to postgres;
alter function public.list_private_conversation_unread_counts() owner to postgres;
alter function public.create_message_notification() owner to postgres;
alter function public.mark_private_conversation_read(uuid) owner to postgres;

revoke all on function public.create_group_conversation(text, text, text, uuid[]) from public, anon, authenticated;
revoke all on function public.lookup_group_member(text) from public, anon, authenticated;
revoke all on function public.list_my_group_conversations() from public, anon, authenticated;
revoke all on function public.list_group_conversation_members(uuid) from public, anon, authenticated;
revoke all on function public.update_group_conversation(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.add_group_conversation_members(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.remove_group_conversation_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.promote_group_conversation_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.leave_group_conversation(uuid) from public, anon, authenticated;
revoke all on function public.set_group_conversation_muted(uuid, boolean) from public, anon, authenticated;
revoke all on function public.list_private_conversation_unread_counts() from public, anon, authenticated;
revoke all on function public.create_message_notification() from public, anon, authenticated;
revoke all on function public.mark_private_conversation_read(uuid) from public, anon, authenticated;

grant execute on function public.create_group_conversation(text, text, text, uuid[]) to authenticated;
grant execute on function public.lookup_group_member(text) to authenticated;
grant execute on function public.list_my_group_conversations() to authenticated;
grant execute on function public.list_group_conversation_members(uuid) to authenticated;
grant execute on function public.update_group_conversation(uuid, text, text, text) to authenticated;
grant execute on function public.add_group_conversation_members(uuid, uuid[]) to authenticated;
grant execute on function public.remove_group_conversation_member(uuid, uuid) to authenticated;
grant execute on function public.promote_group_conversation_member(uuid, uuid) to authenticated;
grant execute on function public.leave_group_conversation(uuid) to authenticated;
grant execute on function public.set_group_conversation_muted(uuid, boolean) to authenticated;
grant execute on function public.list_private_conversation_unread_counts() to authenticated;
grant execute on function public.mark_private_conversation_read(uuid) to authenticated;

commit;
