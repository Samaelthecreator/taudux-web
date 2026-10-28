\set ON_ERROR_STOP on

-- Destructive by design: run only in the isolated database named below.
do $guard$
begin
  if current_database() <> 'taudux_sesiones_solo_vivas_0057_test' then
    raise exception 'Refusing to run outside taudux_sesiones_solo_vivas_0057_test';
  end if;
end
$guard$;

set timezone = 'America/Mexico_City';

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$roles$;

-- Lo que Supabase concede por su cuenta: TODO a anon/authenticated en tablas y
-- funciones nuevas de public. Sin reproducirlo, un `revoke` olvidado pasaría.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  email text
);

-- Mismo stand-in que 0055/0056.
create table auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz,
  updated_at timestamptz,
  factor_id uuid,
  aal text,
  not_after timestamptz,
  refreshed_at timestamp without time zone,
  user_agent text,
  ip inet,
  tag text
);

create table auth.refresh_tokens (
  id bigserial primary key,
  token text,
  user_id text,
  session_id uuid references auth.sessions (id) on delete cascade
);

create function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant execute on function auth.jwt() to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Stand-in de pg_cron (0056).
create schema cron;
create table cron.job (
  jobid bigserial primary key,
  schedule text not null,
  command text not null,
  jobname text
);
create function cron.schedule(p_jobname text, p_schedule text, p_command text)
returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command)
  values (p_jobname, p_schedule, p_command)
  returning jobid;
$$;
create function cron.unschedule(p_jobid bigint)
returns boolean language sql as $$
  with borrado as (delete from cron.job where jobid = p_jobid returning 1)
  select exists (select 1 from borrado);
$$;

-- Stand-in de Storage: lo justo para sus políticas.
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.objects (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  bucket_id text not null,
  name text not null,
  owner uuid
);
alter table storage.objects enable row level security;
grant all on storage.objects to anon, authenticated, service_role;
create policy objetos_select on storage.objects for select to anon, authenticated using (true);
create policy objetos_insert on storage.objects for insert to authenticated with check (true);
create policy objetos_update on storage.objects for update to authenticated using (true) with check (true);
create policy objetos_delete on storage.objects for delete to authenticated using (true);

-- Stand-ins de las tablas de public: una de datos propios por fila, una de
-- datos propios con escritura, y los cuatro catálogos (lectura pública y
-- escritura abierta a authenticated, como si fuera un administrador).
create table public.perfiles (
  id uuid primary key references auth.users (id),
  nombre text
);
alter table public.perfiles enable row level security;
create policy perfiles_propio on public.perfiles for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create table public.qr_codigos (
  id bigserial primary key,
  user_id uuid not null references auth.users (id),
  nombre text
);
alter table public.qr_codigos enable row level security;
create policy qr_codigos_propio on public.qr_codigos for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

do $catalogos$
declare
  v_tabla text;
begin
  foreach v_tabla in array array['cursos', 'categorias', 'extractor_planes', 'qr_planes'] loop
    execute format('create table public.%I (id bigserial primary key, nombre text)', v_tabla);
    execute format('alter table public.%I enable row level security', v_tabla);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)',
                   v_tabla || '_lectura', v_tabla);
    execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)',
                   v_tabla || '_escritura', v_tabla);
  end loop;
end
$catalogos$;

-- Una tabla SIN RLS queda fuera (no es de esta regla).
create table public.sin_rls (id int);

create function pg_temp.assert_true(condition boolean, message text)
returns void language plpgsql as $assert$
begin
  if condition is distinct from true then
    raise exception 'assertion failed: %', message;
  end if;
end
$assert$;

create function pg_temp.como(p_user uuid, p_sesion uuid)
returns void language sql as $como$
  select set_config(
    'request.jwt.claims',
    coalesce(
      pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object('sub', p_user, 'session_id', p_sesion)
      )::text,
      ''
    ),
    false
  );
$como$;

insert into auth.users (id, email) values
  ('57000000-0000-4000-8000-00000000000a', 'a@example.com'),
  ('57000000-0000-4000-8000-00000000000b', 'b@example.com');

\ir ../migrations/0055_sesiones_activas.sql
\ir ../migrations/0056_sesiones_limpieza_pg_cron.sql
\ir ../migrations/0057_sesiones_solo_vivas.sql

-- Las sesiones van después de 0055: al aplicar cierra todas las existentes (S11).
-- 01 y 02 vivas de A; 03 viva de B; 99 cerrada (ya no está en auth.sessions).
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at) values
  ('57000000-0000-4000-8000-000000000001', '57000000-0000-4000-8000-00000000000a', now(), now(), (now() at time zone 'UTC')::timestamp),
  ('57000000-0000-4000-8000-000000000002', '57000000-0000-4000-8000-00000000000a', now(), now(), (now() at time zone 'UTC')::timestamp),
  ('57000000-0000-4000-8000-000000000003', '57000000-0000-4000-8000-00000000000b', now(), now(), (now() at time zone 'UTC')::timestamp);

insert into public.perfiles (id, nombre) values
  ('57000000-0000-4000-8000-00000000000a', 'A'),
  ('57000000-0000-4000-8000-00000000000b', 'B');
insert into public.qr_codigos (user_id, nombre) values
  ('57000000-0000-4000-8000-00000000000a', 'qr de A');
insert into public.cursos (nombre) values ('Curso 1');
insert into public.categorias (nombre) values ('Datos');
insert into storage.objects (bucket_id, name, owner) values
  ('slides', 'a/uno.html', '57000000-0000-4000-8000-00000000000a');

-- 1. Forma de las políticas: restrictive, sólo authenticated; los catálogos
--    sólo en escritura; toda tabla con RLS cubierta; la tabla sin RLS no.
select pg_temp.assert_true(
  (select bool_and(permissive = 'RESTRICTIVE' and roles = '{authenticated}')
     from pg_policies where policyname like '%sesion_viva'),
  'las políticas son restrictive y sólo para authenticated'
);
select pg_temp.assert_true(
  (select array_agg(cmd order by cmd) = array['DELETE', 'INSERT', 'UPDATE']
     from pg_policies
    where schemaname = 'public' and tablename = 'cursos' and policyname like '%sesion_viva'),
  'cursos: sólo insert/update/delete, la lectura no cambia'
);
select pg_temp.assert_true(
  (select count(*) = 4 * 3 from pg_policies
    where schemaname = 'public' and policyname like '%sesion_viva'
      and tablename in ('cursos', 'categorias', 'extractor_planes', 'qr_planes')),
  'los cuatro catálogos tienen sus tres políticas de escritura'
);
select pg_temp.assert_true(
  (select count(*) = 3 from pg_policies
    where schemaname = 'public' and policyname like '%sesion_viva' and cmd = 'ALL'
      and tablename in ('perfiles', 'qr_codigos', 'sesiones_presencia')),
  'tablas de datos (incluida sesiones_presencia): una política for all'
);
select pg_temp.assert_true(
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sin_rls'),
  'una tabla sin RLS no recibe política'
);
select pg_temp.assert_true(
  (select array_agg(cmd order by cmd) = array['DELETE', 'INSERT', 'UPDATE']
     from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname like '%sesion_viva'),
  'storage.objects: sólo insert/update/delete'
);

-- 2. Privilegios: sesion_viva sólo para authenticated.
select pg_temp.assert_true(
  has_function_privilege('authenticated', 'public.sesion_viva()', 'execute')
    and not has_function_privilege('anon', 'public.sesion_viva()', 'execute'),
  'sesion_viva: authenticated sí, anon no'
);
select pg_temp.assert_true(
  (select provolatile = 's' and prosecdef from pg_proc where oid = 'public.sesion_viva()'::regprocedure),
  'sesion_viva es stable y security definer (una evaluación por sentencia)'
);

-- 3. Con la sesión viva todo sigue como antes.
select pg_temp.como('57000000-0000-4000-8000-00000000000a', '57000000-0000-4000-8000-000000000001');
set role authenticated;
select pg_temp.assert_true(public.sesion_viva(), 'la sesión 01 está viva');
select pg_temp.assert_true(
  (select count(*) = 1 from public.perfiles) and (select count(*) = 1 from public.qr_codigos),
  'sesión viva: ve su perfil y su QR'
);
insert into public.qr_codigos (user_id, nombre) values ('57000000-0000-4000-8000-00000000000a', 'otro de A');
update public.perfiles set nombre = 'A2';
insert into public.cursos (nombre) values ('Curso 2');
insert into storage.objects (bucket_id, name, owner) values ('slides', 'a/dos.html', '57000000-0000-4000-8000-00000000000a');
reset role;
select pg_temp.assert_true(
  (select count(*) = 2 from public.qr_codigos)
    and (select nombre = 'A2' from public.perfiles where id = '57000000-0000-4000-8000-00000000000a')
    and (select count(*) = 2 from public.cursos)
    and (select count(*) = 2 from storage.objects),
  'sesión viva: crea, edita, escribe en el catálogo y sube archivos'
);

-- 4. Con una sesión cerrada (99), con token sin session_id, o con la sesión
--    de otra persona: nada de datos, catálogo legible pero no editable, sin
--    subir ni borrar archivos.
create function pg_temp.sin_acceso(p_caso text)
returns void language plpgsql as $sin$
declare
  v_n integer;
begin
  perform pg_temp.assert_true(not public.sesion_viva(), p_caso || ': sesion_viva es false');
  perform pg_temp.assert_true((select count(*) = 0 from public.perfiles), p_caso || ': no ve su perfil');
  perform pg_temp.assert_true((select count(*) = 0 from public.qr_codigos), p_caso || ': no ve sus QR');

  begin
    insert into public.qr_codigos (user_id, nombre) values ('57000000-0000-4000-8000-00000000000a', 'no');
    raise exception 'assertion failed: %: no debió crear un QR', p_caso;
  exception when insufficient_privilege then null;
  end;

  update public.perfiles set nombre = 'no';
  get diagnostics v_n = row_count;
  perform pg_temp.assert_true(v_n = 0, p_caso || ': no edita su perfil');

  delete from public.qr_codigos;
  get diagnostics v_n = row_count;
  perform pg_temp.assert_true(v_n = 0, p_caso || ': no borra sus QR');

  perform pg_temp.assert_true((select count(*) = 2 from public.cursos), p_caso || ': el catálogo se sigue leyendo');
  begin
    insert into public.cursos (nombre) values ('no');
    raise exception 'assertion failed: %: no debió escribir en el catálogo', p_caso;
  exception when insufficient_privilege then null;
  end;
  update public.cursos set nombre = 'no';
  get diagnostics v_n = row_count;
  perform pg_temp.assert_true(v_n = 0, p_caso || ': no edita el catálogo');
  delete from public.categorias;
  get diagnostics v_n = row_count;
  perform pg_temp.assert_true(v_n = 0 and (select count(*) = 1 from public.categorias),
                              p_caso || ': no borra del catálogo');

  perform pg_temp.assert_true((select count(*) = 2 from storage.objects), p_caso || ': los archivos se siguen viendo');
  begin
    insert into storage.objects (bucket_id, name) values ('slides', 'a/no.html');
    raise exception 'assertion failed: %: no debió subir un archivo', p_caso;
  exception when insufficient_privilege then null;
  end;
  update storage.objects set name = 'a/no.html';
  get diagnostics v_n = row_count;
  perform pg_temp.assert_true(v_n = 0, p_caso || ': no renombra archivos');
  delete from storage.objects;
  get diagnostics v_n = row_count;
  perform pg_temp.assert_true(v_n = 0, p_caso || ': no borra archivos');
end
$sin$;

select pg_temp.como('57000000-0000-4000-8000-00000000000a', '57000000-0000-4000-8000-000000000099');
set role authenticated;
select pg_temp.sin_acceso('sesión cerrada');
reset role;

select pg_temp.como('57000000-0000-4000-8000-00000000000a', null);
set role authenticated;
select pg_temp.sin_acceso('token sin session_id');
reset role;

select pg_temp.como('57000000-0000-4000-8000-00000000000a', '57000000-0000-4000-8000-000000000003');
set role authenticated;
select pg_temp.sin_acceso('sesión de otra persona');
reset role;

-- 5. Cerrar desde una sesión cerrada no cierra nada (L20).
select pg_temp.como('57000000-0000-4000-8000-00000000000a', '57000000-0000-4000-8000-000000000099');
set role authenticated;
select pg_temp.assert_true(
  public.sesion_cerrar('57000000-0000-4000-8000-000000000002') = false,
  'sesión cerrada: sesion_cerrar responde false'
);
select pg_temp.assert_true(
  public.sesiones_cerrar_demas() = 0,
  'sesión cerrada: sesiones_cerrar_demas cierra 0'
);
reset role;
select pg_temp.assert_true(
  (select count(*) = 2 from auth.sessions where user_id = '57000000-0000-4000-8000-00000000000a'),
  'sesión cerrada: las sesiones de A siguen vivas'
);

-- 6. Desde una sesión viva siguen funcionando (regresión de 0055/0056).
select pg_temp.como('57000000-0000-4000-8000-00000000000a', '57000000-0000-4000-8000-000000000001');
set role authenticated;
select pg_temp.assert_true(
  public.sesion_cerrar('57000000-0000-4000-8000-000000000002') = true,
  'sesión viva: sesion_cerrar cierra la 02'
);
reset role;
insert into auth.sessions (id, user_id, created_at, updated_at) values
  ('57000000-0000-4000-8000-000000000004', '57000000-0000-4000-8000-00000000000a', now(), now());
select pg_temp.como('57000000-0000-4000-8000-00000000000a', '57000000-0000-4000-8000-000000000001');
set role authenticated;
select pg_temp.assert_true(
  public.sesiones_cerrar_demas() = 1,
  'sesión viva: sesiones_cerrar_demas cierra la 04'
);
reset role;
select pg_temp.assert_true(
  (select array_agg(id::text order by id) = array['57000000-0000-4000-8000-000000000001', '57000000-0000-4000-8000-000000000003']
     from auth.sessions)
    and (select count(*) = 2 from public.sesiones_presencia where motivo_cierre = 'cerrada por ti'),
  'quedan la 01 de A y la 03 de B; 02 y 04 en el historial como «cerrada por ti»'
);
select pg_temp.assert_true(
  has_function_privilege('authenticated', 'public.sesion_cerrar(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.sesion_cerrar(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.sesiones_cerrar_demas()', 'execute')
    and not has_function_privilege('anon', 'public.sesiones_cerrar_demas()', 'execute'),
  'los grants de sesion_cerrar y sesiones_cerrar_demas no cambian'
);

-- 7. anon no cambia: lee el catálogo y los archivos públicos.
select pg_temp.como(null, null);
set role anon;
select pg_temp.assert_true(
  (select count(*) = 2 from public.cursos) and (select count(*) = 2 from storage.objects),
  'anon sigue leyendo el catálogo y los archivos'
);
reset role;

-- 8. Reaplicar es seguro: mismas políticas, ni una más.
create temp table politicas_antes as
  select schemaname, tablename, policyname, cmd from pg_policies where policyname like '%sesion_viva';
\ir ../migrations/0057_sesiones_solo_vivas.sql
select pg_temp.assert_true(
  (select count(*) from pg_policies where policyname like '%sesion_viva')
    = (select count(*) from politicas_antes)
  and not exists (
    select schemaname, tablename, policyname, cmd from pg_policies where policyname like '%sesion_viva'
    except
    select * from politicas_antes
  ),
  'al reaplicar las políticas son las mismas'
);

-- 9. Una tabla con RLS creada después queda cubierta al reaplicar.
create table public.nueva (id int);
alter table public.nueva enable row level security;
\ir ../migrations/0057_sesiones_solo_vivas.sql
select pg_temp.assert_true(
  exists (select 1 from pg_policies where tablename = 'nueva' and policyname = 'nueva_sesion_viva'),
  'al reaplicar, la tabla nueva queda cubierta'
);

\echo 'OK 0057_sesiones_solo_vivas'
