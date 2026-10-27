create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (char_length(username) between 3 and 32),
  display_name text check (display_name is null or char_length(display_name) <= 80),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('private', 'group')),
  title text check (title is null or char_length(title) between 1 and 100),
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'admin')),
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references auth.users (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 10000),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

create table public.message_receipts (
  message_id uuid not null references public.messages (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'delivered' check (status in ('delivered', 'read')),
  updated_at timestamptz not null default now(),
  primary key (message_id, recipient_id)
);

create function public.set_message_receipt_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

revoke all on function public.set_message_receipt_updated_at() from public, anon, authenticated;

create trigger message_receipts_set_updated_at
  before update on public.message_receipts
  for each row execute function public.set_message_receipt_updated_at();

create index conversations_created_by_idx on public.conversations (created_by, created_at desc);
create index conversation_members_user_idx on public.conversation_members (user_id, joined_at desc);
create index messages_conversation_page_idx on public.messages (conversation_id, created_at desc, id desc);
create index messages_sender_idx on public.messages (sender_id, created_at desc);
create index message_receipts_recipient_idx on public.message_receipts (recipient_id, updated_at desc);

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_receipts enable row level security;

revoke all privileges on table
  public.profiles,
  public.conversations,
  public.conversation_members,
  public.messages,
  public.message_receipts
from anon, authenticated;

grant select on table
  public.profiles,
  public.conversations,
  public.conversation_members,
  public.messages,
  public.message_receipts
to authenticated;

grant insert (id, username, display_name, avatar_url)
  on public.profiles to authenticated;
grant update (display_name, avatar_url)
  on public.profiles to authenticated;

grant insert (kind, title, created_by)
  on public.conversations to authenticated;

grant insert (conversation_id, user_id)
  on public.conversation_members to authenticated;

grant insert (conversation_id, sender_id, body)
  on public.messages to authenticated;

grant insert (message_id, recipient_id),
  update (status)
  on public.message_receipts to authenticated;

create policy "Users can read their own profile"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

create policy "Users can create their own profile"
  on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));

create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "Members can read their conversations"
  on public.conversations for select to authenticated
  using (exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = conversations.id and cm.user_id = (select auth.uid())
  ) or created_by = (select auth.uid()));

create policy "Authenticated users can create conversations"
  on public.conversations for insert to authenticated
  with check (created_by = (select auth.uid()));

create policy "Users can read their own memberships"
  on public.conversation_members for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Conversation creators can add themselves"
  on public.conversation_members for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and role = 'member'
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_members.conversation_id and c.created_by = (select auth.uid())
    )
  );

create policy "Members can read messages in their conversations"
  on public.messages for select to authenticated
  using (exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = messages.conversation_id and cm.user_id = (select auth.uid())
  ));

create policy "Members can send messages as themselves"
  on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = messages.conversation_id and cm.user_id = (select auth.uid())
    )
  );

create policy "Recipients can read their own message receipts"
  on public.message_receipts for select to authenticated
  using (
    recipient_id = (select auth.uid())
    and exists (
      select 1 from public.messages m
      join public.conversation_members cm on cm.conversation_id = m.conversation_id
      where m.id = message_receipts.message_id
        and m.sender_id <> (select auth.uid())
        and cm.user_id = (select auth.uid())
    )
  );

create policy "Recipients can create their own message receipts"
  on public.message_receipts for insert to authenticated
  with check (
    recipient_id = (select auth.uid())
    and exists (
      select 1 from public.messages m
      join public.conversation_members cm on cm.conversation_id = m.conversation_id
      where m.id = message_receipts.message_id
        and m.sender_id <> (select auth.uid())
        and cm.user_id = (select auth.uid())
    )
  );

create policy "Recipients can update their own message receipts"
  on public.message_receipts for update to authenticated
  using (
    recipient_id = (select auth.uid())
    and status = 'delivered'
    and exists (
      select 1 from public.messages m
      join public.conversation_members cm on cm.conversation_id = m.conversation_id
      where m.id = message_receipts.message_id
        and m.sender_id <> (select auth.uid())
        and cm.user_id = (select auth.uid())
    )
  )
  with check (
    recipient_id = (select auth.uid())
    and status = 'read'
    and exists (
      select 1 from public.messages m
      join public.conversation_members cm on cm.conversation_id = m.conversation_id
      where m.id = message_receipts.message_id
        and m.sender_id <> (select auth.uid())
        and cm.user_id = (select auth.uid())
    )
  );

comment on table public.conversation_members is
  'Users may only add themselves as members of conversations they created. Invitations, group membership management, and membership removal remain disabled until a trusted authorization flow is implemented.';
comment on table public.message_receipts is
  'Receipt updates are limited to the authenticated recipient; trusted delivery orchestration is not implemented yet.';
