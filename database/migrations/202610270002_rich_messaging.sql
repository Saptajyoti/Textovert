-- Apply once as the postgres role, after 202610270001_realtime_presence_read_receipts.sql.
begin;

alter table public.messages
  add column message_type text not null default 'text'
    check (message_type in ('text', 'image', 'file')),
  add column attachment_path text,
  add column attachment_name text,
  add column attachment_mime text,
  add column attachment_size bigint,
  add column reply_to_id uuid references public.messages (id) on delete set null;

alter table public.messages
  add constraint messages_attachment_metadata_check check (
    (message_type = 'text'
      and attachment_path is null
      and attachment_name is null
      and attachment_mime is null
      and attachment_size is null)
    or (message_type in ('image', 'file')
      and attachment_path is not null
      and attachment_name is not null
      and attachment_mime is not null
      and attachment_size between 1 and 10485760)
  );

create index messages_reply_to_idx on public.messages (reply_to_id)
  where reply_to_id is not null;

grant insert (conversation_id, sender_id, body, message_type, attachment_path,
  attachment_name, attachment_mime, attachment_size, reply_to_id)
  on public.messages to authenticated;

create function public.validate_rich_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reply_conversation uuid;
begin
  if new.reply_to_id is not null then
    select m.conversation_id into v_reply_conversation
    from public.messages m
    where m.id = new.reply_to_id;
    if not found or v_reply_conversation <> new.conversation_id then
      raise exception 'Replies must reference a message in the same conversation.'
        using errcode = '23514';
    end if;
  end if;

  if new.message_type in ('image', 'file') then
    if new.attachment_path !~ (
      '^' || new.conversation_id::text || '/' || new.sender_id::text ||
      '/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) or not exists (
      select 1
      from storage.objects o
      where o.bucket_id = 'conversation-media'
        and o.name = new.attachment_path
        and o.metadata->>'mimetype' = new.attachment_mime
        and (o.metadata->>'size') ~ '^[0-9]+$'
        and (o.metadata->>'size')::bigint = new.attachment_size
    ) then
      raise exception 'Attachment metadata must reference a validated private upload.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

alter function public.validate_rich_message() owner to postgres;
revoke all on function public.validate_rich_message() from public, anon, authenticated;

create trigger messages_validate_rich_message
  before insert or update of reply_to_id, message_type, attachment_path, attachment_name,
    attachment_mime, attachment_size
  on public.messages
  for each row execute function public.validate_rich_message();

create table public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  reaction text not null check (reaction in ('👍', '❤️', '😂', '😮', '😢', '🙏')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, reaction)
);

create index message_reactions_message_idx on public.message_reactions (message_id);
alter table public.message_reactions enable row level security;
revoke all privileges on table public.message_reactions from anon, authenticated;
grant select, insert, delete on table public.message_reactions to authenticated;

create policy "Conversation members can read message reactions"
  on public.message_reactions for select to authenticated
  using (exists (
    select 1
    from public.messages m
    join public.conversation_members cm on cm.conversation_id = m.conversation_id
    where m.id = message_reactions.message_id
      and cm.user_id = (select auth.uid())
      and (select public.can_access_private_conversation(m.conversation_id))
  ));

create policy "Users can add their own message reactions"
  on public.message_reactions for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.messages m
      join public.conversation_members cm on cm.conversation_id = m.conversation_id
      where m.id = message_reactions.message_id
        and cm.user_id = (select auth.uid())
        and (select public.can_access_private_conversation(m.conversation_id))
    )
  );

create policy "Users can remove their own message reactions"
  on public.message_reactions for delete to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.messages m
      join public.conversation_members cm on cm.conversation_id = m.conversation_id
      where m.id = message_reactions.message_id
        and cm.user_id = (select auth.uid())
        and (select public.can_access_private_conversation(m.conversation_id))
    )
  );

do $$
begin
  if exists (select 1 from storage.buckets where id = 'conversation-media') then
    raise exception 'The conversation-media bucket already exists; inspect it before applying this migration.';
  end if;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'conversation-media',
  'conversation-media',
  false,
  10485760,
  array[
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf', 'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
);

create policy "Conversation members can read private conversation media"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'conversation-media'
    and array_length(storage.foldername(name), 1) = 2
    and (select public.can_access_private_conversation(
      ((storage.foldername(name))[1])::uuid
    ))
  );

create policy "Users can remove their own private conversation uploads"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'conversation-media'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and (select public.can_access_private_conversation(
      ((storage.foldername(name))[1])::uuid
    ))
  );

commit;
