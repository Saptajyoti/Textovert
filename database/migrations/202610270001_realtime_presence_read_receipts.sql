-- Apply once as the postgres role. Receipt backfill and authorization changes are atomic.
begin;

create function public.list_private_conversation_partners()
returns table (conversation_id uuid, partner_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, partner.user_id
  from public.conversations c
  join public.conversation_members self
    on self.conversation_id = c.id
   and self.user_id = (select auth.uid())
  join public.conversation_members partner
    on partner.conversation_id = c.id
   and partner.user_id <> (select auth.uid())
  where c.kind = 'private'
    and public.can_access_private_conversation(c.id);
$$;

alter function public.list_private_conversation_partners() owner to postgres;
revoke all on function public.list_private_conversation_partners() from public, anon, authenticated;
grant execute on function public.list_private_conversation_partners() to authenticated;

create function public.create_message_receipts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.message_receipts (message_id, recipient_id, status)
  select new.id, cm.user_id, 'delivered'
  from public.conversation_members cm
  where cm.conversation_id = new.conversation_id
    and cm.user_id <> new.sender_id
  on conflict (message_id, recipient_id) do nothing;

  return new;
end;
$$;

alter function public.create_message_receipts() owner to postgres;
revoke all on function public.create_message_receipts() from public, anon, authenticated;

create trigger messages_create_receipts
  after insert on public.messages
  for each row execute function public.create_message_receipts();

insert into public.message_receipts (message_id, recipient_id, status)
select m.id, cm.user_id, 'delivered'
from public.messages m
join public.conversation_members cm on cm.conversation_id = m.conversation_id
where cm.user_id <> m.sender_id
on conflict (message_id, recipient_id) do nothing;

create policy "Senders can read receipts for their messages"
  on public.message_receipts for select to authenticated
  using (exists (
    select 1
    from public.messages m
    join public.conversation_members cm on cm.conversation_id = m.conversation_id
    where m.id = message_receipts.message_id
      and m.sender_id = (select auth.uid())
      and cm.user_id = (select auth.uid())
  ));

create function public.mark_private_conversation_read(p_conversation_id uuid)
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

alter function public.mark_private_conversation_read(uuid) owner to postgres;
revoke all on function public.mark_private_conversation_read(uuid) from public, anon, authenticated;
grant execute on function public.mark_private_conversation_read(uuid) to authenticated;

commit;
