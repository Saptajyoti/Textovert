-- Apply once as the postgres role. The transaction makes preflight/DDL/backfill atomic.
begin;

create table public.private_conversation_pairs (
  user_low_id uuid not null references auth.users (id) on delete cascade,
  user_high_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null unique references public.conversations (id) on delete cascade,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (user_low_id, user_high_id),
  constraint private_conversation_pairs_canonical_check
    check (user_low_id < user_high_id)
);

create table public.private_conversation_invitations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  conversation_id uuid not null unique
    references public.private_conversation_pairs (conversation_id) on delete cascade,
  inviter_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default pg_catalog.now(),
  responded_at timestamptz,
  constraint private_conversation_invitations_distinct_users_check
    check (inviter_id <> recipient_id),
  constraint private_conversation_invitations_status_time_check
    check (
      (status = 'pending' and responded_at is null)
      or (status in ('accepted', 'rejected') and responded_at is not null)
    )
);

create table public.private_username_lookup_limits (
  user_id uuid primary key references auth.users (id) on delete cascade,
  window_started_at timestamptz not null,
  attempts integer not null check (attempts > 0)
);

create index private_conversation_invitations_incoming_idx
  on public.private_conversation_invitations (recipient_id, created_at desc)
  where status = 'pending';

alter table public.private_conversation_pairs enable row level security;
alter table public.private_conversation_invitations enable row level security;
alter table public.private_username_lookup_limits enable row level security;

revoke all privileges on table
  public.private_conversation_pairs,
  public.private_conversation_invitations,
  public.private_username_lookup_limits
from public, anon, authenticated;

do $$
begin
  if exists (
    select 1
    from public.profiles p
    where p.username !~ '^[A-Za-z0-9_]{3,32}$'
  ) then
    raise exception 'Cannot migrate profiles with usernames outside the supported letters, numbers, and underscore format.';
  end if;

  if exists (
    select 1
    from public.conversations c
    left join public.conversation_members cm on cm.conversation_id = c.id
    where c.kind = 'private'
    group by c.id, c.created_by
    having pg_catalog.count(cm.user_id) not between 1 and 2
      or not pg_catalog.bool_or(cm.user_id = c.created_by)
      or pg_catalog.bool_or(cm.role <> 'member')
  ) then
    raise exception 'Cannot migrate private conversations with zero or more than two members, without their creator as a member, or with non-member roles.';
  end if;
end;
$$;

do $$
begin
  if exists (
    select pg_catalog.lower(p.username)
    from public.profiles p
    group by pg_catalog.lower(p.username)
    having pg_catalog.count(*) > 1
  ) then
    raise exception 'Cannot migrate duplicate usernames that differ only by case.';
  end if;

  if exists (
    select members.user_low_id, members.user_high_id
    from (
      select
        (pg_catalog.array_agg(cm.user_id order by cm.user_id))[1] as user_low_id,
        (pg_catalog.array_agg(cm.user_id order by cm.user_id))[2] as user_high_id
      from public.conversations c
      join public.conversation_members cm on cm.conversation_id = c.id
      where c.kind = 'private'
      group by c.id
      having pg_catalog.count(*) = 2
    ) as members
    group by members.user_low_id, members.user_high_id
    having pg_catalog.count(*) > 1
  ) then
    raise exception 'Cannot migrate duplicate private conversations for the same pair of users.';
  end if;
end;
$$;

create unique index profiles_username_case_insensitive_uidx
  on public.profiles (pg_catalog.lower(username));

-- Backfill only complete pairs; a singleton has no safe, inferable recipient.
insert into public.private_conversation_pairs (
  user_low_id,
  user_high_id,
  conversation_id
)
select
  members.user_low_id,
  members.user_high_id,
  members.conversation_id
from (
  select
    c.id as conversation_id,
    (pg_catalog.array_agg(cm.user_id order by cm.user_id))[1] as user_low_id,
    (pg_catalog.array_agg(cm.user_id order by cm.user_id))[2] as user_high_id
  from public.conversations c
  join public.conversation_members cm on cm.conversation_id = c.id
  where c.kind = 'private'
  group by c.id
  having pg_catalog.count(*) = 2
) as members;

do $$
begin
  if exists (
    select p.user_low_id, p.user_high_id
    from public.private_conversation_pairs p
    group by p.user_low_id, p.user_high_id
    having pg_catalog.count(*) > 1
  ) then
    raise exception 'Cannot migrate duplicate private conversations for the same pair of users.';
  end if;
end;
$$;

insert into public.private_conversation_invitations (
  conversation_id,
  inviter_id,
  recipient_id,
  status,
  created_at,
  responded_at
)
select
  p.conversation_id,
  c.created_by,
  case
    when p.user_low_id = c.created_by then p.user_high_id
    else p.user_low_id
  end,
  'accepted',
  c.created_at,
  c.created_at
from public.private_conversation_pairs p
join public.conversations c on c.id = p.conversation_id;

create function public.guard_private_conversation_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_creator_id uuid;
  v_pair public.private_conversation_pairs%rowtype;
  v_invitation public.private_conversation_invitations%rowtype;
  v_member_count bigint;
begin
  if tg_op = 'DELETE' then
    select c.kind
      into v_kind
    from public.conversations c
    where c.id = old.conversation_id;

    if not found or v_kind <> 'private' or pg_catalog.pg_trigger_depth() > 1 then
      return old;
    end if;

    raise exception 'Private conversation memberships cannot be deleted independently.'
      using errcode = '42501';
  elsif tg_op = 'UPDATE' then
    select c.kind
      into v_kind
    from public.conversations c
    where c.id = old.conversation_id;

    if v_kind = 'private' then
      raise exception 'Private conversation memberships cannot be updated.'
        using errcode = '42501';
    end if;

    select c.kind
      into v_kind
    from public.conversations c
    where c.id = new.conversation_id;

    if v_kind = 'private' then
      raise exception 'Memberships cannot be moved into a private conversation.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  select c.kind, c.created_by
    into v_kind, v_creator_id
  from public.conversations c
  where c.id = new.conversation_id;

  if v_kind = 'private' then
    select p.*
      into v_pair
    from public.private_conversation_pairs p
    where p.conversation_id = new.conversation_id
    for update;

    if found then
      if new.user_id not in (v_pair.user_low_id, v_pair.user_high_id)
        or new.role <> 'member'
        or (select auth.uid()) is distinct from new.user_id then
        raise exception 'Only a participant may add themselves as an ordinary member.'
          using errcode = '42501';
      end if;

      select i.*
        into v_invitation
      from public.private_conversation_invitations i
      where i.conversation_id = new.conversation_id
      for update;

      if not found
        or v_invitation.status <> 'pending'
        or v_invitation.recipient_id <> new.user_id
        or not exists (
          select 1
          from public.conversation_members cm
          where cm.conversation_id = new.conversation_id
            and cm.user_id = v_invitation.inviter_id
            and cm.role = 'member'
        ) then
        raise exception 'A private conversation member may be added only by accepting their pending invitation.'
          using errcode = '42501';
      end if;

      select pg_catalog.count(*)
        into v_member_count
      from public.conversation_members cm
      where cm.conversation_id = new.conversation_id;

      if v_member_count <> 1 then
        raise exception 'A pending private conversation must have exactly one inviter before acceptance.'
          using errcode = '23514';
      end if;
    elsif new.user_id <> v_creator_id
      or new.role <> 'member'
      or (select auth.uid()) is distinct from new.user_id
      or exists (
        select 1
        from public.conversation_members cm
        where cm.conversation_id = new.conversation_id
      ) then
      raise exception 'Unpaired private conversations may only contain their creator.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_private_conversation_member() from public, anon, authenticated;

create trigger conversation_members_guard_private
  before insert or update or delete on public.conversation_members
  for each row execute function public.guard_private_conversation_member();

create function public.guard_private_conversation_invitation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pair public.private_conversation_pairs%rowtype;
  v_member_count bigint;
begin
  if tg_op = 'DELETE' then
    if pg_catalog.pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'Private invitation records cannot be deleted independently.'
      using errcode = '42501';
  end if;

  select p.*
    into v_pair
  from public.private_conversation_pairs p
  where p.conversation_id = new.conversation_id
  for update;

  if not found
    or new.inviter_id not in (v_pair.user_low_id, v_pair.user_high_id)
    or new.recipient_id not in (v_pair.user_low_id, v_pair.user_high_id) then
    raise exception 'Invitation users must be the canonical private conversation participants.'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'pending'
      or new.responded_at is not null
      or new.inviter_id is distinct from (select auth.uid())
      or not exists (
        select 1
        from public.conversation_members cm
        where cm.conversation_id = new.conversation_id
          and cm.user_id = new.inviter_id
          and cm.role = 'member'
      ) then
      raise exception 'A pending invitation may only be created by its authenticated inviter.'
        using errcode = '42501';
    end if;

    select pg_catalog.count(*)
      into v_member_count
    from public.conversation_members cm
    where cm.conversation_id = new.conversation_id;

    if v_member_count <> 1 then
      raise exception 'A new private invitation requires exactly one inviter member.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
    or new.conversation_id is distinct from old.conversation_id
    or new.inviter_id is distinct from old.inviter_id
    or new.recipient_id is distinct from old.recipient_id then
    raise exception 'Private invitation identity and participants are immutable.'
      using errcode = '42501';
  end if;

  if old.status = 'pending'
    and new.status in ('accepted', 'rejected')
    and new.created_at = old.created_at
    and new.responded_at is not null
    and (select auth.uid()) = old.recipient_id then
    select pg_catalog.count(*)
      into v_member_count
    from public.conversation_members cm
    where cm.conversation_id = new.conversation_id;

    if new.status = 'accepted' then
      if v_member_count <> 2
        or not exists (
          select 1 from public.conversation_members cm
          where cm.conversation_id = new.conversation_id
            and cm.user_id = new.inviter_id
            and cm.role = 'member'
        )
        or not exists (
          select 1 from public.conversation_members cm
          where cm.conversation_id = new.conversation_id
            and cm.user_id = new.recipient_id
            and cm.role = 'member'
        ) then
        raise exception 'An accepted private conversation must contain exactly its two ordinary participants.'
          using errcode = '23514';
      end if;
    elsif v_member_count <> 1
      or not exists (
        select 1 from public.conversation_members cm
        where cm.conversation_id = new.conversation_id
          and cm.user_id = new.inviter_id
          and cm.role = 'member'
      ) then
      raise exception 'A rejected invitation must leave exactly its inviter as an ordinary member.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status = 'rejected'
    and new.status = 'pending'
    and new.responded_at is null
    and new.created_at >= old.created_at
    and (select auth.uid()) = old.inviter_id then
    select pg_catalog.count(*)
      into v_member_count
    from public.conversation_members cm
    where cm.conversation_id = new.conversation_id;

    if v_member_count <> 1
      or not exists (
        select 1 from public.conversation_members cm
        where cm.conversation_id = new.conversation_id
          and cm.user_id = new.inviter_id
          and cm.role = 'member'
      ) then
      raise exception 'A rejected invitation can be reopened only by its original inviter while they are the sole member.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  raise exception 'The requested private invitation state transition is not authorized.'
    using errcode = '42501';
end;
$$;

revoke all on function public.guard_private_conversation_invitation() from public, anon, authenticated;

create trigger private_conversation_invitations_guard
  before insert or update or delete on public.private_conversation_invitations
  for each row execute function public.guard_private_conversation_invitation();

create function public.can_access_private_conversation(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.private_conversation_pairs p
    join public.private_conversation_invitations i
      on i.conversation_id = p.conversation_id
     and i.status = 'accepted'
    where p.conversation_id = p_conversation_id
        and (
          (i.inviter_id = p.user_low_id and i.recipient_id = p.user_high_id)
          or (i.inviter_id = p.user_high_id and i.recipient_id = p.user_low_id)
        )
        and (p.user_low_id = (select auth.uid()) or p.user_high_id = (select auth.uid()))
      and (
        select pg_catalog.count(*)
        from public.conversation_members cm
        where cm.conversation_id = p.conversation_id
      ) = 2
      and exists (
        select 1
        from public.conversation_members cm
        where cm.conversation_id = p.conversation_id
          and cm.user_id = (select auth.uid())
          and cm.role = 'member'
      )
      and not exists (
        select 1
        from public.conversation_members cm
        where cm.conversation_id = p.conversation_id
          and (
            cm.user_id not in (p.user_low_id, p.user_high_id)
            or cm.role <> 'member'
          )
      )
  );
$$;

revoke all on function public.can_access_private_conversation(uuid) from public, anon, authenticated;
grant execute on function public.can_access_private_conversation(uuid) to authenticated;

create function public.consume_private_username_lookup_quota()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_attempts integer;
begin
  if v_user_id is null then
    return false;
  end if;

  insert into public.private_username_lookup_limits as quota (
    user_id,
    window_started_at,
    attempts
  )
  values (v_user_id, pg_catalog.now(), 1)
  on conflict (user_id) do update
  set window_started_at = case
        when quota.window_started_at <= pg_catalog.now() - interval '15 minutes'
          then pg_catalog.now()
        else quota.window_started_at
      end,
      attempts = case
        when quota.window_started_at <= pg_catalog.now() - interval '15 minutes'
          then 1
        else quota.attempts + 1
      end
  returning attempts into v_attempts;

  return v_attempts <= 30;
end;
$$;

revoke all on function public.consume_private_username_lookup_quota() from public, anon, authenticated;

create policy "Only accepted private participants can access messages"
  on public.messages as restrictive for all to authenticated
  using (
    exists (
      select 1
      from public.conversations c
      where c.id = messages.conversation_id
        and (
          c.kind <> 'private'
          or public.can_access_private_conversation(c.id)
        )
    )
  )
  with check (
    exists (
      select 1
      from public.conversations c
      where c.id = messages.conversation_id
        and (
          c.kind <> 'private'
          or public.can_access_private_conversation(c.id)
        )
    )
  );

create policy "Private conversation details require membership"
  on public.conversations as restrictive for select to authenticated
  using (
    kind <> 'private'
    or exists (
      select 1
      from public.conversation_members cm
      where cm.conversation_id = conversations.id
        and cm.user_id = (select auth.uid())
    )
  );

create policy "Private conversations must use invitation workflow"
  on public.conversations as restrictive for insert to authenticated
  with check (kind <> 'private');

create function public.lookup_private_user(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_target public.profiles%rowtype;
  v_pair public.private_conversation_pairs%rowtype;
  v_invitation public.private_conversation_invitations%rowtype;
  v_relationship text := 'none';
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

  select p.*
    into v_target
  from public.profiles p
  where pg_catalog.lower(p.username) = pg_catalog.lower(pg_catalog.btrim(p_username));

  if not found then
    return pg_catalog.jsonb_build_object('found', false);
  end if;
  if v_target.id = v_user_id then
    return pg_catalog.jsonb_build_object(
      'found', true,
      'username', v_target.username,
      'display_name', v_target.display_name,
      'relationship', 'self'
    );
  end if;

  select p.*
    into v_pair
  from public.private_conversation_pairs p
  where p.user_low_id = case when v_user_id < v_target.id then v_user_id else v_target.id end
    and p.user_high_id = case when v_user_id > v_target.id then v_user_id else v_target.id end;

  if found then
    select i.*
      into v_invitation
    from public.private_conversation_invitations i
    where i.conversation_id = v_pair.conversation_id;

    if found then
      if v_invitation.status = 'accepted'
        and public.can_access_private_conversation(v_pair.conversation_id) then
        v_relationship := 'existing';
      elsif v_invitation.status = 'accepted' then
        raise exception 'Accepted private conversation membership is inconsistent.'
          using errcode = '23514';
      elsif v_invitation.status = 'pending' and v_invitation.recipient_id = v_user_id then
        v_relationship := 'invitation_received';
      elsif v_invitation.status = 'pending' then
        v_relationship := 'invitation_sent';
      else
        v_relationship := 'invitation_rejected';
      end if;
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'found', true,
    'username', v_target.username,
    'display_name', v_target.display_name,
    'relationship', v_relationship,
    'conversation_id', case when v_relationship = 'existing' then v_pair.conversation_id else null end
  );
end;
$$;

revoke all on function public.lookup_private_user(text) from public, anon, authenticated;

create function public.start_private_conversation(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_target public.profiles%rowtype;
  v_low_id uuid;
  v_high_id uuid;
  v_pair public.private_conversation_pairs%rowtype;
  v_invitation public.private_conversation_invitations%rowtype;
  v_conversation_id uuid;
  v_relationship text;
  v_created boolean := false;
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

  select p.*
    into v_target
  from public.profiles p
  where pg_catalog.lower(p.username) = pg_catalog.lower(pg_catalog.btrim(p_username));

  if not found then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;

  if v_target.id = v_user_id then
    return pg_catalog.jsonb_build_object('status', 'self');
  end if;

  v_low_id := case when v_user_id < v_target.id then v_user_id else v_target.id end;
  v_high_id := case when v_user_id > v_target.id then v_user_id else v_target.id end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_low_id::text || ':' || v_high_id::text, 0)
  );

  select p.*
    into v_pair
  from public.private_conversation_pairs p
  where p.user_low_id = v_low_id
    and p.user_high_id = v_high_id
  for update;

  if not found then
    insert into public.conversations (kind, created_by)
    values ('private', v_user_id)
    returning id into v_conversation_id;

    insert into public.conversation_members (conversation_id, user_id, role)
    values (v_conversation_id, v_user_id, 'member');

    insert into public.private_conversation_pairs (
      user_low_id,
      user_high_id,
      conversation_id
    )
    values (v_low_id, v_high_id, v_conversation_id)
    returning conversation_id into v_conversation_id;

    insert into public.private_conversation_invitations (
      conversation_id,
      inviter_id,
      recipient_id
    )
    values (v_conversation_id, v_user_id, v_target.id)
    returning * into v_invitation;

    return pg_catalog.jsonb_build_object(
      'status', 'invitation_sent',
      'created', true,
      'invitation_id', v_invitation.id,
      'conversation_id', v_conversation_id,
      'username', v_target.username
    );
  else
    v_conversation_id := v_pair.conversation_id;
  end if;

  select i.*
    into v_invitation
  from public.private_conversation_invitations i
  where i.conversation_id = v_conversation_id
  for update;

  if not found then
    raise exception 'Private conversation invitation state is missing.'
      using errcode = '23514';
  end if;

  if v_invitation.status = 'accepted'
    and public.can_access_private_conversation(v_conversation_id) then
    v_relationship := 'existing';
  elsif v_invitation.status = 'accepted' then
    raise exception 'Accepted private conversation membership is inconsistent.'
      using errcode = '23514';
  elsif v_invitation.status = 'pending' and v_invitation.recipient_id = v_user_id then
    v_relationship := 'invitation_received';
  elsif v_invitation.status = 'pending' then
    v_relationship := 'invitation_sent';
  elsif v_invitation.inviter_id <> v_user_id then
    v_relationship := 'invitation_rejected';
  else
    update public.private_conversation_invitations i
    set status = 'pending',
        created_at = pg_catalog.now(),
        responded_at = null
    where i.id = v_invitation.id
    returning * into v_invitation;
    v_relationship := 'invitation_sent';
    v_created := true;
  end if;

  return pg_catalog.jsonb_build_object(
    'status', v_relationship,
    'created', v_created,
    'invitation_id', v_invitation.id,
    'conversation_id', v_conversation_id,
    'username', v_target.username
  );
end;
$$;

revoke all on function public.start_private_conversation(text) from public, anon, authenticated;

create function public.list_incoming_private_invitations()
returns table (
  invitation_id uuid,
  conversation_id uuid,
  inviter_username text,
  inviter_display_name text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    i.id,
    i.conversation_id,
    p.username,
    p.display_name,
    i.created_at
  from public.private_conversation_invitations i
  join public.profiles p on p.id = i.inviter_id
  where i.recipient_id = (select auth.uid())
    and i.status = 'pending'
  order by i.created_at desc;
$$;

revoke all on function public.list_incoming_private_invitations() from public, anon, authenticated;

create function public.respond_to_private_invitation(p_invitation_id uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_conversation_id uuid;
  v_invitation public.private_conversation_invitations%rowtype;
  v_pair public.private_conversation_pairs%rowtype;
  v_member_count bigint;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_invitation_id is null or p_accept is null then
    raise exception 'Invitation ID and response are required.'
      using errcode = '22023';
  end if;

  select i.conversation_id
    into v_conversation_id
  from public.private_conversation_invitations i
  where i.id = p_invitation_id;

  if not found then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;

  select p.*
    into v_pair
  from public.private_conversation_pairs p
  where p.conversation_id = v_conversation_id
  for update;

  select i.*
    into v_invitation
  from public.private_conversation_invitations i
  where i.id = p_invitation_id
  for update;

  if not found
    or v_invitation.conversation_id <> v_conversation_id
    or v_invitation.recipient_id <> v_user_id
    or v_invitation.inviter_id = v_user_id then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;

  if v_invitation.status = 'rejected' then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'conversation_id', v_invitation.conversation_id
    );
  end if;

  if v_invitation.status = 'accepted' then
    if not public.can_access_private_conversation(v_invitation.conversation_id) then
      raise exception 'Accepted private conversation membership is inconsistent.'
        using errcode = '23514';
    end if;
    return pg_catalog.jsonb_build_object(
      'status', 'accepted',
      'conversation_id', v_invitation.conversation_id
    );
  end if;

  if not p_accept then
    update public.private_conversation_invitations i
    set status = 'rejected',
        responded_at = pg_catalog.now()
    where i.id = v_invitation.id;

    return pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'conversation_id', v_invitation.conversation_id
    );
  end if;

  if v_pair.conversation_id is null
    or v_user_id not in (v_pair.user_low_id, v_pair.user_high_id)
    or v_invitation.inviter_id not in (v_pair.user_low_id, v_pair.user_high_id) then
    raise exception 'Invitation does not match its private participant pair.'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.conversation_members cm
    where cm.conversation_id = v_invitation.conversation_id
      and cm.user_id = v_invitation.inviter_id
  ) then
    raise exception 'The inviter is not a member of this private conversation.'
      using errcode = '23514';
  end if;

  insert into public.conversation_members (conversation_id, user_id, role)
  values (v_invitation.conversation_id, v_user_id, 'member')
  on conflict (conversation_id, user_id) do nothing;

  select pg_catalog.count(*)
    into v_member_count
  from public.conversation_members cm
  where cm.conversation_id = v_invitation.conversation_id;

  if v_member_count <> 2 then
    raise exception 'Accepted private conversations must have exactly two members.'
      using errcode = '23514';
  end if;

  update public.private_conversation_invitations i
  set status = 'accepted',
      responded_at = pg_catalog.now()
  where i.id = v_invitation.id;

  return pg_catalog.jsonb_build_object(
    'status', 'accepted',
    'conversation_id', v_invitation.conversation_id
  );
end;
$$;

revoke all on function public.respond_to_private_invitation(uuid, boolean) from public, anon, authenticated;

create function public.list_my_private_conversations()
returns table (
  id uuid,
  kind text,
  title text,
  partner_username text,
  partner_display_name text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.id,
    c.kind,
    coalesce(partner.display_name, partner.username) as title,
    partner.username as partner_username,
    partner.display_name as partner_display_name,
    c.created_at as created_at,
    c.updated_at as updated_at
  from public.private_conversation_pairs pair
  join public.conversations c on c.id = pair.conversation_id and c.kind = 'private'
  join public.private_conversation_invitations i
    on i.conversation_id = c.id and i.status = 'accepted'
   and (
     (i.inviter_id = pair.user_low_id and i.recipient_id = pair.user_high_id)
     or (i.inviter_id = pair.user_high_id and i.recipient_id = pair.user_low_id)
   )
  join public.profiles partner
    on partner.id = case
      when pair.user_low_id = (select auth.uid()) then pair.user_high_id
      else pair.user_low_id
    end
  where (pair.user_low_id = (select auth.uid()) or pair.user_high_id = (select auth.uid()))
    and (
      select pg_catalog.count(*)
      from public.conversation_members cm
      where cm.conversation_id = c.id
    ) = 2
    and exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = c.id
        and cm.user_id = (select auth.uid())
        and cm.role = 'member'
    )
    and exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = c.id
        and cm.user_id = partner.id
        and cm.role = 'member'
    )
    and not exists (
      select 1
      from public.conversation_members cm
      where cm.conversation_id = c.id
        and (
          cm.user_id not in (pair.user_low_id, pair.user_high_id)
          or cm.role <> 'member'
        )
    )
  order by c.updated_at desc;
$$;

revoke all on function public.list_my_private_conversations() from public, anon, authenticated;

alter function public.guard_private_conversation_member() owner to postgres;
alter function public.guard_private_conversation_invitation() owner to postgres;
alter function public.can_access_private_conversation(uuid) owner to postgres;
alter function public.consume_private_username_lookup_quota() owner to postgres;
alter function public.lookup_private_user(text) owner to postgres;
alter function public.start_private_conversation(text) owner to postgres;
alter function public.list_incoming_private_invitations() owner to postgres;
alter function public.respond_to_private_invitation(uuid, boolean) owner to postgres;
alter function public.list_my_private_conversations() owner to postgres;

revoke all on function public.guard_private_conversation_member() from public, anon, authenticated;
revoke all on function public.guard_private_conversation_invitation() from public, anon, authenticated;
revoke all on function public.can_access_private_conversation(uuid) from public, anon, authenticated;
revoke all on function public.consume_private_username_lookup_quota() from public, anon, authenticated;
revoke all on function public.lookup_private_user(text) from public, anon, authenticated;
revoke all on function public.start_private_conversation(text) from public, anon, authenticated;
revoke all on function public.list_incoming_private_invitations() from public, anon, authenticated;
revoke all on function public.respond_to_private_invitation(uuid, boolean) from public, anon, authenticated;
revoke all on function public.list_my_private_conversations() from public, anon, authenticated;

grant execute on function public.can_access_private_conversation(uuid) to authenticated;
grant execute on function public.lookup_private_user(text) to authenticated;
grant execute on function public.start_private_conversation(text) to authenticated;
grant execute on function public.list_incoming_private_invitations() to authenticated;
grant execute on function public.respond_to_private_invitation(uuid, boolean) to authenticated;
grant execute on function public.list_my_private_conversations() to authenticated;

comment on table public.private_conversation_pairs is
  'Private pair index with canonical participant ordering; direct client access is denied.';
comment on table public.private_conversation_invitations is
  'Private invitation state. Only recipient-scoped RPCs expose invitations; direct client access is denied.';
comment on table public.private_username_lookup_limits is
  'Server-managed per-user username discovery quota; direct client access is denied.';
comment on table public.conversation_members is
  'For private conversations, direct client inserts remain limited by the original RLS policy; recipient membership is added only by the authenticated invitation acceptance function.';

commit;
