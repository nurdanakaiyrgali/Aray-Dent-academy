-- DentAcademy initial backend schema (Supabase / PostgreSQL)
-- User identity is managed by Supabase Auth; application permissions live in organization_memberships.

create schema if not exists private;

create type public.organization_role as enum ('learner', 'doctor', 'mentor', 'admin', 'chief');
create type public.membership_status as enum ('invited', 'active', 'suspended');
create type public.publication_status as enum ('draft', 'published', 'archived');
create type public.material_type as enum ('lecture', 'book', 'clinical_case', 'protocol', 'interactive_model', 'video', 'notes');
create type public.certificate_status as enum ('pending', 'in_review', 'approved', 'rejected');
create type public.webinar_status as enum ('scheduled', 'live', 'completed', 'cancelled');

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text,
  specialty text,
  region text,
  city text,
  phone text,
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function private.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.create_profile_for_auth_user();

-- Backfill profiles if authentication users already existed before this migration.
insert into public.profiles (id, full_name, email)
select u.id, coalesce(u.raw_user_meta_data ->> 'full_name', ''), u.email
from auth.users u
on conflict (id) do nothing;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  legal_name text,
  bin text,
  legal_form text,
  region text,
  city text,
  address text,
  phone text,
  email text,
  website text,
  license_number text,
  license_expires_on date,
  specialties text[] not null default '{}',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.organization_role not null,
  status public.membership_status not null default 'active',
  invited_by uuid references public.profiles(id),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id, role)
);

create table public.mentor_student_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mentor_id uuid not null references public.profiles(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  approved_by uuid references public.profiles(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, mentor_id, student_id),
  check (mentor_id <> student_id)
);

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  title text not null,
  description text not null default '',
  specialty text,
  author_id uuid references public.profiles(id) on delete set null,
  status public.publication_status not null default 'draft',
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.course_units (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  title text not null,
  description text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (course_id, sort_order)
);

create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.course_units(id) on delete cascade,
  title text not null,
  lesson_type text not null default 'lecture',
  body text not null default '',
  media_path text,
  duration_minutes integer,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (unit_id, sort_order)
);

create table public.library_materials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  title text not null,
  description text not null default '',
  material_type public.material_type not null,
  storage_path text,
  author_id uuid references public.profiles(id) on delete set null,
  status public.publication_status not null default 'draft',
  allow_download boolean not null default false,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.course_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  assigned_by uuid not null references public.profiles(id),
  due_at timestamptz,
  created_at timestamptz not null default now(),
  unique (course_id, student_id)
);

create table public.lesson_progress (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  completed_at timestamptz,
  last_position_seconds integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (lesson_id, student_id)
);

create table public.tests (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid references public.course_units(id) on delete cascade,
  title text not null,
  passing_score integer not null default 85 check (passing_score between 0 and 100),
  status public.publication_status not null default 'draft',
  created_at timestamptz not null default now()
);

create table public.test_questions (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests(id) on delete cascade,
  prompt text not null,
  options jsonb not null default '[]'::jsonb,
  explanation text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.test_attempts (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  score integer check (score between 0 and 100),
  answers jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  submitted_at timestamptz
);

create table public.certificates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  reviewer_id uuid references public.profiles(id),
  title text not null,
  issuer text not null,
  issued_on date,
  storage_path text not null,
  status public.certificate_status not null default 'pending',
  review_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subject text not null default '',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create table public.webinars (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  title text not null,
  description text not null default '',
  starts_at timestamptz not null,
  duration_minutes integer not null default 60,
  capacity integer check (capacity is null or capacity > 0),
  meeting_url text,
  status public.webinar_status not null default 'scheduled',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.webinar_reservations (
  id uuid primary key default gen_random_uuid(),
  webinar_id uuid not null references public.webinars(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  unique (webinar_id, user_id)
);

create table public.saved_materials (
  user_id uuid not null references public.profiles(id) on delete cascade,
  material_id uuid not null references public.library_materials(id) on delete cascade,
  saved_at timestamptz not null default now(),
  primary key (user_id, material_id)
);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'Заметка',
  body text not null default '',
  source_type text,
  source_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index memberships_user_idx on public.organization_memberships(user_id, status);
create index mentor_links_student_idx on public.mentor_student_links(student_id, active);
create index courses_org_status_idx on public.courses(organization_id, status);
create index library_org_status_idx on public.library_materials(organization_id, status);
create index assignments_student_idx on public.course_assignments(student_id, organization_id);
create index progress_student_idx on public.lesson_progress(student_id, updated_at desc);
create index attempts_student_idx on public.test_attempts(student_id, submitted_at desc);
create index certificates_owner_idx on public.certificates(owner_id, created_at desc);
create index messages_conversation_idx on public.messages(conversation_id, created_at);
create index webinars_start_idx on public.webinars(starts_at, status);

create function private.is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = target_org
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  );
$$;

create function private.has_org_role(target_org uuid, allowed_roles public.organization_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = target_org
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and m.role = any(allowed_roles)
  );
$$;

create function private.can_view_student(target_student uuid, target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_student = (select auth.uid())
    or exists (
      select 1 from public.mentor_student_links l
      where l.organization_id = target_org
        and l.student_id = target_student
        and l.mentor_id = (select auth.uid())
        and l.active
    )
    or private.has_org_role(target_org, array['admin','chief']::public.organization_role[]);
$$;

create function private.shares_organization_with(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships mine
    join public.organization_memberships theirs using (organization_id)
    where mine.user_id = (select auth.uid()) and mine.status = 'active'
      and theirs.user_id = target_user and theirs.status = 'active'
  );
$$;

create function private.is_conversation_member(target_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = target_conversation and cm.user_id = (select auth.uid())
  );
$$;

create function private.can_read_course(target_course uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.courses c
    where c.id = target_course
      and (
        (c.status = 'published' and (c.organization_id is null or private.is_org_member(c.organization_id)))
        or c.author_id = (select auth.uid())
        or private.has_org_role(c.organization_id, array['admin','chief']::public.organization_role[])
      )
  );
$$;

revoke all on function private.set_updated_at() from public;
revoke all on function private.create_profile_for_auth_user() from public;
revoke all on function private.is_org_member(uuid) from public;
revoke all on function private.has_org_role(uuid, public.organization_role[]) from public;
revoke all on function private.can_view_student(uuid, uuid) from public;
revoke all on function private.shares_organization_with(uuid) from public;
revoke all on function private.is_conversation_member(uuid) from public;
revoke all on function private.can_read_course(uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.is_org_member(uuid) to authenticated;
grant execute on function private.has_org_role(uuid, public.organization_role[]) to authenticated;
grant execute on function private.can_view_student(uuid, uuid) to authenticated;
grant execute on function private.shares_organization_with(uuid) to authenticated;
grant execute on function private.is_conversation_member(uuid) to authenticated;
grant execute on function private.can_read_course(uuid) to authenticated;

create trigger profiles_updated_at before update on public.profiles for each row execute function private.set_updated_at();
create trigger organizations_updated_at before update on public.organizations for each row execute function private.set_updated_at();
create trigger courses_updated_at before update on public.courses for each row execute function private.set_updated_at();
create trigger materials_updated_at before update on public.library_materials for each row execute function private.set_updated_at();
create trigger progress_updated_at before update on public.lesson_progress for each row execute function private.set_updated_at();
create trigger conversations_updated_at before update on public.conversations for each row execute function private.set_updated_at();
create trigger notes_updated_at before update on public.notes for each row execute function private.set_updated_at();

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.mentor_student_links enable row level security;
alter table public.courses enable row level security;
alter table public.course_units enable row level security;
alter table public.lessons enable row level security;
alter table public.library_materials enable row level security;
alter table public.course_assignments enable row level security;
alter table public.lesson_progress enable row level security;
alter table public.tests enable row level security;
alter table public.test_questions enable row level security;
alter table public.test_attempts enable row level security;
alter table public.certificates enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.webinars enable row level security;
alter table public.webinar_reservations enable row level security;
alter table public.saved_materials enable row level security;
alter table public.notes enable row level security;

create policy "profiles_read_self_or_org" on public.profiles for select to authenticated
using (id = (select auth.uid()) or private.shares_organization_with(id));
create policy "profiles_update_self" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "organizations_read_members" on public.organizations for select to authenticated
using (created_by = (select auth.uid()) or private.is_org_member(id));
create policy "organizations_create_self" on public.organizations for insert to authenticated with check (created_by = (select auth.uid()));
create policy "organizations_update_admin" on public.organizations for update to authenticated using (private.has_org_role(id, array['admin','chief']::public.organization_role[])) with check (private.has_org_role(id, array['admin','chief']::public.organization_role[]));

create policy "memberships_read_self_or_admin" on public.organization_memberships for select to authenticated
using (user_id = (select auth.uid()) or private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));
create policy "membership_first_admin_or_admin_add" on public.organization_memberships for insert to authenticated
with check (
  (user_id = (select auth.uid()) and role = 'admin' and exists (select 1 from public.organizations o where o.id = organization_id and o.created_by = (select auth.uid())))
  or private.has_org_role(organization_id, array['admin','chief']::public.organization_role[])
);
create policy "membership_admin_update" on public.organization_memberships for update to authenticated
using (private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]))
with check (private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));

create policy "mentor_links_read_related_or_admin" on public.mentor_student_links for select to authenticated
using (mentor_id = (select auth.uid()) or student_id = (select auth.uid()) or private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));
create policy "mentor_links_admin_manage" on public.mentor_student_links for all to authenticated
using (private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]))
with check (private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));

create policy "courses_read_published_or_managed" on public.courses for select to authenticated
using ((status = 'published' and (organization_id is null or private.is_org_member(organization_id))) or author_id = (select auth.uid()) or private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));
create policy "courses_admin_create" on public.courses for insert to authenticated
with check (author_id = (select auth.uid()) and organization_id is not null and private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));
create policy "courses_admin_update" on public.courses for update to authenticated
using (private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]))
with check (private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));
create policy "courses_admin_delete" on public.courses for delete to authenticated
using (private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));

create policy "units_read_visible_course" on public.course_units for select to authenticated using (private.can_read_course(course_id));
create policy "units_manage_course_admin" on public.course_units for all to authenticated
using (exists (select 1 from public.courses c where c.id = course_id and private.has_org_role(c.organization_id, array['admin','chief']::public.organization_role[])))
with check (exists (select 1 from public.courses c where c.id = course_id and private.has_org_role(c.organization_id, array['admin','chief']::public.organization_role[])));
create policy "lessons_read_visible_course" on public.lessons for select to authenticated
using (exists (select 1 from public.course_units u where u.id = unit_id and private.can_read_course(u.course_id)));
create policy "lessons_manage_course_admin" on public.lessons for all to authenticated
using (exists (select 1 from public.course_units u join public.courses c on c.id = u.course_id where u.id = unit_id and private.has_org_role(c.organization_id, array['admin','chief']::public.organization_role[])))
with check (exists (select 1 from public.course_units u join public.courses c on c.id = u.course_id where u.id = unit_id and private.has_org_role(c.organization_id, array['admin','chief']::public.organization_role[])));

create policy "materials_read_published_or_managed" on public.library_materials for select to authenticated
using ((status = 'published' and (organization_id is null or private.is_org_member(organization_id))) or author_id = (select auth.uid()) or private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));
create policy "materials_admin_add" on public.library_materials for insert to authenticated
with check (author_id = (select auth.uid()) and organization_id is not null and private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));
create policy "materials_admin_update" on public.library_materials for update to authenticated
using (private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]))
with check (private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));
create policy "materials_admin_delete" on public.library_materials for delete to authenticated
using (private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));

create policy "assignments_student_or_staff_read" on public.course_assignments for select to authenticated
using (private.can_view_student(student_id, organization_id));
create policy "assignments_admin_manage" on public.course_assignments for all to authenticated
using (private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]))
with check (private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));

create policy "progress_student_or_staff_read" on public.lesson_progress for select to authenticated
using (exists (select 1 from public.lessons l join public.course_units u on u.id = l.unit_id join public.courses c on c.id = u.course_id where l.id = lesson_id and private.can_view_student(student_id, c.organization_id)));
create policy "progress_student_write" on public.lesson_progress for insert to authenticated
with check (student_id = (select auth.uid()) and exists (select 1 from public.lessons l join public.course_units u on u.id = l.unit_id where l.id = lesson_id and private.can_read_course(u.course_id)));
create policy "progress_student_update" on public.lesson_progress for update to authenticated
using (student_id = (select auth.uid()) and exists (select 1 from public.lessons l join public.course_units u on u.id = l.unit_id where l.id = lesson_id and private.can_read_course(u.course_id)))
with check (student_id = (select auth.uid()) and exists (select 1 from public.lessons l join public.course_units u on u.id = l.unit_id where l.id = lesson_id and private.can_read_course(u.course_id)));

create policy "tests_read_visible_course" on public.tests for select to authenticated
using (status = 'published' or exists (select 1 from public.course_units u where u.id = unit_id and private.can_read_course(u.course_id)));
create policy "tests_admin_manage" on public.tests for all to authenticated
using (exists (select 1 from public.course_units u join public.courses c on c.id = u.course_id where u.id = unit_id and private.has_org_role(c.organization_id, array['admin','chief']::public.organization_role[])))
with check (exists (select 1 from public.course_units u join public.courses c on c.id = u.course_id where u.id = unit_id and private.has_org_role(c.organization_id, array['admin','chief']::public.organization_role[])));
create policy "questions_read_published_test" on public.test_questions for select to authenticated
using (exists (select 1 from public.tests t where t.id = test_id and t.status = 'published'));
create policy "questions_admin_manage" on public.test_questions for all to authenticated
using (exists (select 1 from public.tests t join public.course_units u on u.id = t.unit_id join public.courses c on c.id = u.course_id where t.id = test_id and private.has_org_role(c.organization_id, array['admin','chief']::public.organization_role[])))
with check (exists (select 1 from public.tests t join public.course_units u on u.id = t.unit_id join public.courses c on c.id = u.course_id where t.id = test_id and private.has_org_role(c.organization_id, array['admin','chief']::public.organization_role[])));
create policy "attempts_student_or_staff_read" on public.test_attempts for select to authenticated
using (student_id = (select auth.uid()) or exists (select 1 from public.tests t join public.course_units u on u.id = t.unit_id join public.courses c on c.id = u.course_id where t.id = test_id and private.can_view_student(student_id, c.organization_id)));
create policy "attempts_student_submit" on public.test_attempts for insert to authenticated
with check (student_id = (select auth.uid()) and score is null and submitted_at is null and answers = '{}'::jsonb and exists (select 1 from public.tests t where t.id = test_id and t.status = 'published'));

create policy "certificates_read_owner_or_staff" on public.certificates for select to authenticated
using (owner_id = (select auth.uid()) or private.can_view_student(owner_id, organization_id));
create policy "certificates_owner_submit" on public.certificates for insert to authenticated
with check (owner_id = (select auth.uid()) and private.is_org_member(organization_id));
create policy "certificates_reviewer_update" on public.certificates for update to authenticated
using (private.has_org_role(organization_id, array['chief','admin']::public.organization_role[]) or exists (select 1 from public.mentor_student_links l where l.organization_id = certificates.organization_id and l.student_id = certificates.owner_id and l.mentor_id = (select auth.uid()) and l.active))
with check (private.has_org_role(organization_id, array['chief','admin']::public.organization_role[]) or exists (select 1 from public.mentor_student_links l where l.organization_id = certificates.organization_id and l.student_id = certificates.owner_id and l.mentor_id = (select auth.uid()) and l.active));

create policy "conversations_read_members" on public.conversations for select to authenticated
using (private.is_conversation_member(id) or private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));
create policy "conversations_create_member" on public.conversations for insert to authenticated
with check (created_by = (select auth.uid()) and private.is_org_member(organization_id));
create policy "conversation_members_read_self_or_staff" on public.conversation_members for select to authenticated
using (user_id = (select auth.uid()) or exists (select 1 from public.conversations c where c.id = conversation_id and private.has_org_role(c.organization_id, array['admin','chief']::public.organization_role[])));
create policy "conversation_members_add_by_participant_or_staff" on public.conversation_members for insert to authenticated
with check (exists (select 1 from public.conversations c where c.id = conversation_id and (c.created_by = (select auth.uid()) or private.has_org_role(c.organization_id, array['admin','chief']::public.organization_role[]))));
create policy "messages_read_conversation_members" on public.messages for select to authenticated
using (private.is_conversation_member(conversation_id) or exists (select 1 from public.conversations c where c.id = conversation_id and private.has_org_role(c.organization_id, array['admin','chief']::public.organization_role[])));
create policy "messages_send_as_self_member" on public.messages for insert to authenticated
with check (sender_id = (select auth.uid()) and private.is_conversation_member(conversation_id));
create policy "messages_mark_read_member" on public.messages for update to authenticated
using (private.is_conversation_member(conversation_id))
with check (private.is_conversation_member(conversation_id));

create policy "webinars_read_scheduled" on public.webinars for select to authenticated
using ((status in ('scheduled','live','completed') and (organization_id is null or private.is_org_member(organization_id))) or private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));
create policy "webinars_admin_manage" on public.webinars for all to authenticated
using (organization_id is not null and private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]))
with check (organization_id is not null and private.has_org_role(organization_id, array['admin','chief']::public.organization_role[]));
create function public.reserve_webinar(target_webinar uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_webinar public.webinars%rowtype;
  reservation_id uuid;
  active_count integer;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select * into current_webinar
  from public.webinars w
  where w.id = target_webinar
  for update;
  if not found then raise exception 'Webinar not found' using errcode = 'P0002'; end if;
  if current_webinar.status <> 'scheduled' or current_webinar.starts_at <= now() then
    raise exception 'Webinar registration is closed' using errcode = '22023';
  end if;
  if current_webinar.organization_id is not null
    and not private.is_org_member(current_webinar.organization_id) then
    raise exception 'Organization membership required' using errcode = '42501';
  end if;
  select count(*) into active_count from public.webinar_reservations r
  where r.webinar_id = target_webinar and r.cancelled_at is null;
  if current_webinar.capacity is not null and active_count >= current_webinar.capacity
    and not exists (select 1 from public.webinar_reservations r where r.webinar_id = target_webinar and r.user_id = (select auth.uid()) and r.cancelled_at is null) then
    raise exception 'Webinar is full' using errcode = '22023';
  end if;
  insert into public.webinar_reservations (webinar_id, user_id)
  values (target_webinar, (select auth.uid()))
  on conflict (webinar_id, user_id) do update
    set cancelled_at = null, cancellation_reason = null
  returning id into reservation_id;
  return reservation_id;
end;
$$;
revoke all on function public.reserve_webinar(uuid) from public;
grant execute on function public.reserve_webinar(uuid) to authenticated;

create function public.cancel_webinar(target_reservation uuid, reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_rows integer;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  update public.webinar_reservations r
  set cancelled_at = now(), cancellation_reason = nullif(btrim(reason), '')
  where r.id = target_reservation and r.user_id = (select auth.uid()) and r.cancelled_at is null;
  get diagnostics changed_rows = row_count;
  return changed_rows = 1;
end;
$$;
revoke all on function public.cancel_webinar(uuid, text) from public;
grant execute on function public.cancel_webinar(uuid, text) to authenticated;

create policy "reservations_read_self_or_staff" on public.webinar_reservations for select to authenticated
using (user_id = (select auth.uid()) or exists (select 1 from public.webinars w where w.id = webinar_id and private.has_org_role(w.organization_id, array['admin','chief','mentor']::public.organization_role[])));
-- New reservations go through public.reserve_webinar(), which locks the webinar row and checks capacity.
-- Cancellation goes through private.cancel_webinar(); there is intentionally no direct UPDATE policy.

create policy "saved_materials_self_manage" on public.saved_materials for all to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "notes_self_manage" on public.notes for all to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Keep sensitive answer keys and storage objects out of public access. Add buckets and their
-- storage.objects policies in a separate migration after storage requirements are agreed.
