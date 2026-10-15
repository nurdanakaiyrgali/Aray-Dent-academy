-- DentAcademy LMS v1: two trusted roles, course publishing, materials and tests.
-- Forward-only migration. Keeps legacy rows for review; it does not delete old clinical data.

begin;

-- A person's learner status (student/intern/practicing doctor) is profile data,
-- never an authorization role. Only an explicitly promoted account is admin.
alter table public.profiles
  add column if not exists role text not null default 'learner',
  add column if not exists learner_status text not null default 'student',
  add column if not exists experience_years integer,
  add column if not exists is_active boolean not null default true;

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('learner','admin'));
alter table public.profiles drop constraint if exists profiles_learner_status_check;
alter table public.profiles add constraint profiles_learner_status_check
  check (learner_status in ('student','intern','practicing_doctor'));
alter table public.profiles drop constraint if exists profiles_experience_years_check;
alter table public.profiles add constraint profiles_experience_years_check
  check (experience_years is null or experience_years between 0 and 80);

create or replace function private.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin' and p.is_active
  );
$$;

-- Enforce the two-role policy for every pre-existing policy that relies on this
-- helper. Legacy membership enum values remain only to preserve old records;
-- they no longer grant permissions. Only active admin memberships can manage org data.
create or replace function private.has_org_role(
  target_org uuid, allowed_roles public.organization_role[]
)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_platform_admin()
    and 'admin' = any(allowed_roles);
$$;

revoke all on function private.is_platform_admin() from public;
grant execute on function private.is_platform_admin() to authenticated;
revoke all on function private.has_org_role(uuid, public.organization_role[]) from public;
grant execute on function private.has_org_role(uuid, public.organization_role[]) to authenticated;

-- Do not let a user promote themself by changing profiles.role via the API.
create or replace function private.guard_profile_security_fields()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and old.role is distinct from new.role then
    raise exception 'Profile role can only be changed by a trusted administrator';
  end if;
  if auth.uid() is not null and old.is_active is distinct from new.is_active then
    raise exception 'Account status can only be changed by a trusted administrator';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard_security_fields on public.profiles;
create trigger profiles_guard_security_fields before update on public.profiles
  for each row execute function private.guard_profile_security_fields();

-- Limit profile editing to ordinary self-service fields; role/status are not writable.
revoke update on public.profiles from authenticated;
grant update (full_name, specialty, region, city, phone, avatar_path,
              learner_status, experience_years, updated_at)
  on public.profiles to authenticated;

-- A course can belong to a direction and carry catalog/prerequisite metadata.
create table if not exists public.directions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique,
  description text not null default '',
  sort_order integer not null default 0,
  status public.publication_status not null default 'draft',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.courses
  add column if not exists direction_id uuid references public.directions(id) on delete set null,
  add column if not exists level text not null default 'basic',
  add column if not exists tags text[] not null default '{}',
  add column if not exists target_audience text[] not null default '{}',
  add column if not exists published_at timestamptz;
alter table public.courses drop constraint if exists courses_level_check;
alter table public.courses add constraint courses_level_check check (level in ('basic','advanced','expert'));
alter table public.course_units add column if not exists status public.publication_status not null default 'draft';
alter table public.lessons add column if not exists status public.publication_status not null default 'draft';
alter table public.lessons add column if not exists content_markdown text not null default '';

create table if not exists public.course_prerequisites (
  course_id uuid not null references public.courses(id) on delete cascade,
  required_course_id uuid not null references public.courses(id) on delete restrict,
  bypass_test_id uuid references public.tests(id) on delete set null,
  primary key (course_id, required_course_id),
  check (course_id <> required_course_id)
);
create or replace function private.reject_prerequisite_cycle()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (
    with recursive chain(course_id, required_course_id) as (
      select p.course_id, p.required_course_id from public.course_prerequisites p
      where p.course_id = new.required_course_id
        and (tg_op <> 'UPDATE' or (p.course_id, p.required_course_id) <> (old.course_id, old.required_course_id))
      union all
      select p.course_id, p.required_course_id from public.course_prerequisites p
      join chain c on p.course_id = c.required_course_id
      where (tg_op <> 'UPDATE' or (p.course_id, p.required_course_id) <> (old.course_id, old.required_course_id))
    ) select 1 from chain where required_course_id = new.course_id
  ) then raise exception 'Course prerequisites cannot contain a cycle'; end if;
  return new;
end;
$$;
drop trigger if exists course_prerequisites_no_cycle on public.course_prerequisites;
create trigger course_prerequisites_no_cycle before insert or update on public.course_prerequisites
  for each row execute function private.reject_prerequisite_cycle();

create table if not exists public.study_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  name text not null,
  description text not null default '',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);
create table if not exists public.study_group_members (
  group_id uuid not null references public.study_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  group_id uuid references public.study_groups(id) on delete set null,
  state text not null default 'active' check (state in ('active','completed','withdrawn')),
  enrolled_at timestamptz not null default now(),
  unique (user_id, course_id)
);
insert into public.enrollments(user_id, course_id, enrolled_at)
select student_id, course_id, min(created_at) from public.course_assignments
group by student_id, course_id on conflict (user_id, course_id) do nothing;

create table if not exists public.lesson_materials (
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  material_id uuid not null references public.library_materials(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (lesson_id, material_id)
);
alter table public.library_materials
  add column if not exists mime_type text,
  add column if not exists byte_size bigint check (byte_size is null or byte_size >= 0),
  add column if not exists version integer not null default 1,
  add column if not exists uploaded_at timestamptz not null default now();

-- Keep the legacy test tables intact for audit, but new LMS assessments use
-- normalized answer options so correct answers never reach learner queries.
alter table public.tests
  add column if not exists course_id uuid references public.courses(id) on delete cascade,
  add column if not exists kind text not null default 'module' check (kind in ('entry','module','final')),
  add column if not exists description text not null default '',
  add column if not exists instructions text not null default '',
  add column if not exists settings jsonb not null default '{"max_attempts":3,"time_limit_minutes":null,"shuffle_questions":true,"shuffle_options":true}'::jsonb;

create table if not exists public.lms_questions (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests(id) on delete cascade,
  prompt text not null,
  question_type text not null default 'single_choice'
    check (question_type in ('single_choice','multiple_choice','true_false')),
  points numeric(8,2) not null default 1 check (points > 0),
  explanation text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (test_id, sort_order)
);
create table if not exists public.lms_answer_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.lms_questions(id) on delete cascade,
  option_text text not null,
  is_correct boolean not null default false,
  sort_order integer not null default 0,
  unique (question_id, sort_order)
);
create table if not exists public.test_assignments (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  group_id uuid references public.study_groups(id) on delete cascade,
  available_from timestamptz,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  check ((user_id is not null)::integer + (group_id is not null)::integer = 1),
  unique nulls not distinct (test_id, user_id, group_id)
);
create table if not exists public.lms_test_attempts (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  answers jsonb not null default '{}'::jsonb,
  score numeric(8,2),
  max_score numeric(8,2),
  percentage numeric(5,2) check (percentage is null or percentage between 0 and 100),
  passed boolean,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  grading_snapshot jsonb,
  unique (test_id, user_id, attempt_number)
);
create table if not exists public.prerequisite_waivers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null,
  required_course_id uuid not null,
  source_attempt_id uuid references public.lms_test_attempts(id) on delete set null,
  granted_at timestamptz not null default now(),
  unique (user_id, course_id, required_course_id),
  foreign key (course_id, required_course_id)
    references public.course_prerequisites(course_id, required_course_id) on delete cascade
);

-- Platform-level admin check is the source of authority. Old org memberships
-- are preserved, but learner accounts and legacy mentor/chief memberships cannot grant admin.
create or replace function private.can_manage_course(target_course uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_platform_admin() and exists (
    select 1 from public.courses c
    where c.id = target_course
      and (c.organization_id is null or private.has_org_role(c.organization_id, array['admin']::public.organization_role[]))
  );
$$;
create or replace function private.can_access_course(target_course uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.courses c
    where c.id = target_course and (
      (c.status = 'published' and (c.organization_id is null or private.is_org_member(c.organization_id)))
      or private.can_manage_course(c.id)
      or exists (select 1 from public.enrollments e where e.course_id = c.id and e.user_id = (select auth.uid()) and e.state in ('active','completed'))
    )
  );
$$;
revoke all on function private.can_manage_course(uuid), private.can_access_course(uuid) from public;
grant execute on function private.can_manage_course(uuid), private.can_access_course(uuid) to authenticated;

-- The legacy profile-wide sharing behavior is disabled: profiles are self-only
-- unless an authorized admin is querying the account-management screen.
drop policy if exists profiles_read_self_or_org on public.profiles;
create policy profiles_read_self_or_admin on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.is_platform_admin());

-- Remove mentoring-specific access and clinical approval UI/API data access.
drop policy if exists mentor_links_read_related_or_admin on public.mentor_student_links;
drop policy if exists mentor_links_admin_manage on public.mentor_student_links;
create policy legacy_mentor_links_admin_only on public.mentor_student_links for all to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());
drop policy if exists certificates_read_owner_or_staff on public.certificates;
drop policy if exists certificates_owner_submit on public.certificates;
drop policy if exists certificates_reviewer_update on public.certificates;
create policy certificates_read_owner_or_admin on public.certificates for select to authenticated
  using (owner_id = (select auth.uid()) or private.is_platform_admin());
create policy certificates_submit_self on public.certificates for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy certificates_admin_review on public.certificates for update to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());

-- Hide old demo question records from learners; admin retains access for migration/audit.
drop policy if exists questions_read_published_test on public.test_questions;
drop policy if exists questions_admin_manage on public.test_questions;
create policy legacy_questions_admin_only on public.test_questions for all to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());

alter table public.directions enable row level security;
alter table public.course_prerequisites enable row level security;
alter table public.study_groups enable row level security;
alter table public.study_group_members enable row level security;
alter table public.enrollments enable row level security;
alter table public.lesson_materials enable row level security;
alter table public.lms_questions enable row level security;
alter table public.lms_answer_options enable row level security;
alter table public.test_assignments enable row level security;
alter table public.lms_test_attempts enable row level security;
alter table public.prerequisite_waivers enable row level security;

create policy directions_read_published_or_admin on public.directions for select to authenticated
  using (status = 'published' or private.is_platform_admin());
create policy directions_admin_manage on public.directions for all to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy prerequisites_read_visible on public.course_prerequisites for select to authenticated
  using (private.can_access_course(course_id));
create policy prerequisites_admin_manage on public.course_prerequisites for all to authenticated
  using (private.can_manage_course(course_id)) with check (private.can_manage_course(course_id));
create policy groups_admin_manage on public.study_groups for all to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy groups_member_read on public.study_groups for select to authenticated
  using (exists (select 1 from public.study_group_members gm where gm.group_id = id and gm.user_id = (select auth.uid())) or private.is_platform_admin());
create policy group_members_read_self_or_admin on public.study_group_members for select to authenticated
  using (user_id = (select auth.uid()) or private.is_platform_admin());
create policy group_members_admin_manage on public.study_group_members for all to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy enrollments_read_self_or_admin on public.enrollments for select to authenticated
  using (user_id = (select auth.uid()) or private.is_platform_admin());
create policy enrollments_admin_manage on public.enrollments for all to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy lesson_materials_read_allowed on public.lesson_materials for select to authenticated
  using (exists (select 1 from public.lessons l join public.course_units u on u.id = l.unit_id where l.id = lesson_id and private.can_access_course(u.course_id)));
create policy lesson_materials_admin_manage on public.lesson_materials for all to authenticated
  using (exists (select 1 from public.lessons l join public.course_units u on u.id = l.unit_id where l.id = lesson_id and private.can_manage_course(u.course_id)))
  with check (exists (select 1 from public.lessons l join public.course_units u on u.id = l.unit_id where l.id = lesson_id and private.can_manage_course(u.course_id)));

-- Make the old course tables obey the trusted role and course enrollment checks.
drop policy if exists courses_read_published_or_managed on public.courses;
drop policy if exists courses_admin_create on public.courses;
drop policy if exists courses_admin_update on public.courses;
drop policy if exists courses_admin_delete on public.courses;
create policy courses_read_accessible on public.courses for select to authenticated
  using ((status = 'published' and (organization_id is null or private.is_org_member(organization_id))) or private.can_manage_course(id) or exists (select 1 from public.enrollments e where e.course_id = id and e.user_id = (select auth.uid())));
create policy courses_admin_create_v2 on public.courses for insert to authenticated
  with check (author_id = (select auth.uid()) and private.is_platform_admin());
create policy courses_admin_update_v2 on public.courses for update to authenticated
  using (private.can_manage_course(id)) with check (private.can_manage_course(id));
create policy courses_admin_delete_v2 on public.courses for delete to authenticated
  using (private.can_manage_course(id));

drop policy if exists units_read_visible_course on public.course_units;
drop policy if exists units_manage_course_admin on public.course_units;
create policy units_read_visible_course_v2 on public.course_units for select to authenticated
  using ((status = 'published' and private.can_access_course(course_id)) or private.can_manage_course(course_id));
create policy units_admin_manage_v2 on public.course_units for all to authenticated
  using (private.can_manage_course(course_id)) with check (private.can_manage_course(course_id));
drop policy if exists lessons_read_visible_course on public.lessons;
drop policy if exists lessons_manage_course_admin on public.lessons;
create policy lessons_read_accessible_v2 on public.lessons for select to authenticated
  using ((status = 'published' and exists (select 1 from public.course_units u where u.id = unit_id and u.status = 'published' and private.can_access_course(u.course_id)))
    or exists (select 1 from public.course_units u where u.id = unit_id and private.can_manage_course(u.course_id)));
create policy lessons_admin_manage_v2 on public.lessons for all to authenticated
  using (exists (select 1 from public.course_units u where u.id = unit_id and private.can_manage_course(u.course_id)))
  with check (exists (select 1 from public.course_units u where u.id = unit_id and private.can_manage_course(u.course_id)));

drop policy if exists tests_read_visible_course on public.tests;
drop policy if exists tests_admin_manage on public.tests;
create policy tests_read_accessible_v2 on public.tests for select to authenticated
  using ((status = 'published' and private.can_access_course(coalesce(course_id, (select u.course_id from public.course_units u where u.id = unit_id))))
    or private.can_manage_course(coalesce(course_id, (select u.course_id from public.course_units u where u.id = unit_id))));
create policy tests_admin_manage_v2 on public.tests for all to authenticated
  using (private.can_manage_course(coalesce(course_id, (select u.course_id from public.course_units u where u.id = unit_id))))
  with check (private.can_manage_course(coalesce(course_id, (select u.course_id from public.course_units u where u.id = unit_id))));

-- Learners can read published metadata, never write course or test structures.
create policy lms_questions_admin_all on public.lms_questions for all to authenticated
  using (exists (select 1 from public.tests t where t.id = test_id and private.can_manage_course(coalesce(t.course_id, (select u.course_id from public.course_units u where u.id = t.unit_id)))))
  with check (exists (select 1 from public.tests t where t.id = test_id and private.can_manage_course(coalesce(t.course_id, (select u.course_id from public.course_units u where u.id = t.unit_id)))));
create policy lms_questions_learner_read on public.lms_questions for select to authenticated
  using (exists (select 1 from public.tests t where t.id = test_id and t.status = 'published'
    and private.can_access_course(coalesce(t.course_id, (select u.course_id from public.course_units u where u.id = t.unit_id)))));
create policy lms_options_admin_all on public.lms_answer_options for all to authenticated
  using (exists (select 1 from public.lms_questions q where q.id = question_id and exists (select 1 from public.tests t where t.id = q.test_id and private.can_manage_course(coalesce(t.course_id, (select u.course_id from public.course_units u where u.id = t.unit_id))))) )
  with check (exists (select 1 from public.lms_questions q where q.id = question_id and exists (select 1 from public.tests t where t.id = q.test_id and private.can_manage_course(coalesce(t.course_id, (select u.course_id from public.course_units u where u.id = t.unit_id))))) );
create policy lms_options_learner_read on public.lms_answer_options for select to authenticated
  using (exists (select 1 from public.lms_questions q join public.tests t on t.id = q.test_id
    where q.id = question_id and t.status = 'published'
      and private.can_access_course(coalesce(t.course_id, (select u.course_id from public.course_units u where u.id = t.unit_id)))));
create policy assignments_self_or_admin_read on public.test_assignments for select to authenticated
  using (user_id = (select auth.uid()) or group_id in (select group_id from public.study_group_members where user_id = (select auth.uid())) or private.is_platform_admin());
create policy assignments_admin_manage on public.test_assignments for all to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy attempts_self_or_admin_read on public.lms_test_attempts for select to authenticated
  using (user_id = (select auth.uid()) or private.is_platform_admin());
create policy attempts_self_insert_open on public.lms_test_attempts for insert to authenticated
  with check (user_id = (select auth.uid()) and score is null and percentage is null and passed is null and submitted_at is null and grading_snapshot is null
    and exists (select 1 from public.tests t where t.id = test_id and t.status = 'published'
      and private.can_access_course(coalesce(t.course_id, (select u.course_id from public.course_units u where u.id = t.unit_id)))));
create policy waivers_self_or_admin_read on public.prerequisite_waivers for select to authenticated
  using (user_id = (select auth.uid()) or private.is_platform_admin());
create policy waivers_admin_manage on public.prerequisite_waivers for all to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());

create or replace function public.enroll_in_course(target_course uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_enrollment uuid;
begin
  if auth.uid() is null or private.is_platform_admin() then
    raise exception 'A learner account is required';
  end if;
  if not exists (select 1 from public.courses c where c.id = target_course and c.status = 'published') then
    raise exception 'Course is not open for enrollment';
  end if;
  if exists (select 1 from public.courses c where c.id = target_course and c.organization_id is not null
      and not private.is_org_member(c.organization_id)) then
    raise exception 'This course is not available to this account';
  end if;
  if exists (
    select 1 from public.course_prerequisites p
    where p.course_id = target_course
      and not exists (select 1 from public.enrollments e where e.course_id = p.required_course_id
        and e.user_id = auth.uid() and e.state = 'completed')
      and not exists (select 1 from public.prerequisite_waivers w where w.course_id = p.course_id
        and w.required_course_id = p.required_course_id and w.user_id = auth.uid())
      and not exists (select 1 from public.lms_test_attempts a where a.user_id = auth.uid()
        and a.passed and a.test_id = p.bypass_test_id)
  ) then raise exception 'Complete a prerequisite or pass its entry test first'; end if;
  insert into public.enrollments(user_id, course_id)
    values (auth.uid(), target_course)
    on conflict (user_id, course_id) do update set state = public.enrollments.state
    returning id into new_enrollment;
  return new_enrollment;
end;
$$;
revoke all on function public.enroll_in_course(uuid) from public;
grant execute on function public.enroll_in_course(uuid) to authenticated;

-- Correct answers are writable by admins only and never selectable by learners.
revoke all on public.lms_answer_options from authenticated;
grant select (id, question_id, option_text, sort_order) on public.lms_answer_options to authenticated;
grant insert, update, delete on public.lms_answer_options to authenticated;
create or replace view private.admin_lms_answer_options as
  select o.id, o.question_id, o.option_text, o.is_correct, o.sort_order
  from public.lms_answer_options o where private.is_platform_admin();
grant select on private.admin_lms_answer_options to authenticated;

create or replace function public.start_lms_test_attempt(target_test uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t public.tests%rowtype;
  next_number integer;
  new_id uuid;
  max_attempts integer;
begin
  select * into t from public.tests where id = target_test and status = 'published';
  if not found or not private.can_access_course(coalesce(t.course_id, (select u.course_id from public.course_units u where u.id = t.unit_id))) then
    raise exception 'Test is not available for this account';
  end if;
  if t.kind <> 'entry' and not exists (select 1 from public.enrollments e where e.course_id = coalesce(t.course_id,
      (select u.course_id from public.course_units u where u.id = t.unit_id)) and e.user_id = auth.uid() and e.state in ('active','completed')) then
    raise exception 'Enroll in this course before starting its test';
  end if;
  if exists (select 1 from public.test_assignments a where a.test_id = t.id)
     and not exists (select 1 from public.test_assignments a where a.test_id = t.id and (a.available_from is null or a.available_from <= now())
       and (a.due_at is null or a.due_at >= now()) and (a.user_id = auth.uid()
         or a.group_id in (select gm.group_id from public.study_group_members gm where gm.user_id = auth.uid()))) then
    raise exception 'This test has not been assigned to this learner';
  end if;
  max_attempts := coalesce((t.settings->>'max_attempts')::integer, 3);
  select coalesce(max(attempt_number), 0) + 1 into next_number from public.lms_test_attempts
    where test_id = t.id and user_id = auth.uid();
  if next_number > max_attempts then raise exception 'Attempt limit reached'; end if;
  if exists (select 1 from public.lms_test_attempts a where a.test_id = t.id and a.user_id = auth.uid() and a.submitted_at is null) then
    raise exception 'Submit or resume your existing attempt first';
  end if;
  insert into public.lms_test_attempts(test_id, user_id, attempt_number)
    values (t.id, auth.uid(), next_number) returning id into new_id;
  return jsonb_build_object('attempt_id', new_id, 'attempt_number', next_number,
    'started_at', now(), 'time_limit_minutes', t.settings->'time_limit_minutes');
end;
$$;
revoke all on function public.start_lms_test_attempt(uuid) from public;
grant execute on function public.start_lms_test_attempt(uuid) to authenticated;
grant select, insert, update, delete on public.lms_questions to authenticated;
grant select, insert, update, delete on public.directions, public.course_prerequisites,
  public.study_groups, public.study_group_members, public.enrollments,
  public.lesson_materials, public.test_assignments, public.lms_test_attempts,
  public.prerequisite_waivers to authenticated;
revoke insert, update, delete on public.lms_test_attempts from authenticated;
grant select on public.lms_test_attempts to authenticated;

-- Database-side grading; answer keys are read only inside this SECURITY DEFINER function.
create or replace function public.submit_lms_test_attempt(target_attempt uuid, submitted_answers jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.lms_test_attempts%rowtype;
  q record;
  correct_ids uuid[];
  chosen_ids uuid[];
  total numeric := 0;
  earned numeric := 0;
  pct numeric := 0;
  threshold integer;
  max_attempts integer;
  passed_result boolean;
begin
  select * into a from public.lms_test_attempts where id = target_attempt for update;
  if not found or a.user_id <> auth.uid() or a.submitted_at is not null then
    raise exception 'Attempt not found or already submitted';
  end if;
  if not exists (select 1 from public.tests t where t.id = a.test_id and t.status = 'published') then
    raise exception 'Test is not available';
  end if;
  select t.passing_score, coalesce((t.settings->>'max_attempts')::integer, 3)
    into threshold, max_attempts from public.tests t where t.id = a.test_id;
  if a.attempt_number > max_attempts then raise exception 'Attempt limit reached'; end if;
  for q in select id, points from public.lms_questions where test_id = a.test_id loop
    total := total + q.points;
    select coalesce(array_agg(id order by id), '{}'::uuid[]) into correct_ids
      from public.lms_answer_options where question_id = q.id and is_correct;
    select coalesce(array_agg(x::uuid order by x::uuid), '{}'::uuid[]) into chosen_ids
      from jsonb_array_elements_text(coalesce(submitted_answers->q.id::text, '[]'::jsonb)) x;
    if correct_ids = chosen_ids then earned := earned + q.points; end if;
  end loop;
  if total = 0 then raise exception 'Test has no scored questions'; end if;
  pct := round(earned * 100 / total, 2);
  passed_result := pct >= threshold;
  update public.lms_test_attempts set answers = submitted_answers, score = earned,
    max_score = total, percentage = pct, passed = passed_result,
    submitted_at = now(), grading_snapshot = jsonb_build_object('passing_score', threshold)
  where id = target_attempt;
  return jsonb_build_object('attempt_id', target_attempt, 'score', earned,
    'max_score', total, 'percentage', pct, 'passed', passed_result,
    'attempt_number', a.attempt_number, 'submitted_at', now());
end;
$$;
revoke all on function public.submit_lms_test_attempt(uuid, jsonb) from public;
grant execute on function public.submit_lms_test_attempt(uuid, jsonb) to authenticated;

create index if not exists courses_direction_status_idx on public.courses(direction_id, status);
create index if not exists enrollments_user_state_idx on public.enrollments(user_id, state);
create index if not exists lesson_materials_material_idx on public.lesson_materials(material_id);
create index if not exists lms_questions_test_order_idx on public.lms_questions(test_id, sort_order);
create index if not exists lms_attempts_user_test_idx on public.lms_test_attempts(user_id, test_id, started_at desc);

-- Private object storage. Admin uploads; published course material is read only
-- by enrolled learners through the linked material metadata policy.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('course-materials', 'course-materials', false, 536870912,
  array['application/pdf','video/mp4','video/webm','text/markdown','text/plain','image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists course_materials_admin_upload on storage.objects;
create policy course_materials_admin_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'course-materials' and private.is_platform_admin());
drop policy if exists course_materials_admin_update on storage.objects;
create policy course_materials_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'course-materials' and private.is_platform_admin())
  with check (bucket_id = 'course-materials' and private.is_platform_admin());
drop policy if exists course_materials_admin_delete on storage.objects;
create policy course_materials_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'course-materials' and private.is_platform_admin());
drop policy if exists course_materials_read_published on storage.objects;
create policy course_materials_read_published on storage.objects for select to authenticated
  using (bucket_id = 'course-materials' and exists (
    select 1 from public.library_materials m
    join public.lesson_materials lm on lm.material_id = m.id
    join public.lessons l on l.id = lm.lesson_id
    join public.course_units u on u.id = l.unit_id
    join public.enrollments e on e.course_id = u.course_id
    where m.storage_path = name and m.status = 'published' and e.user_id = auth.uid() and e.state in ('active','completed')
  ));

commit;

-- Bootstrap once in Supabase SQL Editor after this migration:
-- update public.profiles set role = 'admin' where id = '<trusted auth.users UUID>';
-- Admin role changes must be executed by the project owner/DB administrator, never by the web client.
