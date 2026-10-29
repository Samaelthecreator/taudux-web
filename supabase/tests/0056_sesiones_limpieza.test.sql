\set ON_ERROR_STOP on

-- Destructive by design: run only in the isolated database named below.
do $guard$
begin
  if current_database() <> 'taudux_sesiones_limpieza_0056_test' then
    raise exception 'Refusing to run outside taudux_sesiones_limpieza_0056_test';
  end if;
end
$guard$;

-- Una zona distinta de UTC a propósito: refreshed_at no tiene zona y la
-- limpieza debe leerlo como UTC venga de donde venga la conexión.
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

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  email text
);

-- Mismo stand-in que 0055: refreshed_at SIN zona, created_at/updated_at con zona.
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

-- Stand-in de pg_cron: lo justo para cron.job, schedule y unschedule.
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

create function pg_temp.assert_true(condition boolean, message text)
returns void language plpgsql as $assert$
begin
  if condition is distinct from true then
    raise exception 'assertion failed: %', message;
  end if;
end
$assert$;

-- Un minuto de holgura: cada sentencia de psql es su propia transacción.
create function pg_temp.cerca(a timestamptz, b timestamptz)
returns boolean language sql as $cerca$
  select abs(extract(epoch from a - b)) < 60;
$cerca$;

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
  ('56000000-0000-4000-8000-00000000000a', 'a@example.com'),
  ('56000000-0000-4000-8000-00000000000b', 'b@example.com');

\ir ../migrations/0055_sesiones_activas.sql

-- Motivo de cierre de una sesión ('abierta' si su fila sigue sin cerrar,
-- 'sin fila' si no hay presencia).
create function pg_temp.motivo(p_sufijo text)
returns text language sql as $motivo$
  select coalesce(
    (select coalesce(motivo_cierre, 'abierta') from public.sesiones_presencia
      where session_id = ('56000000-0000-4000-8000-0000000000' || p_sufijo)::uuid),
    'sin fila'
  );
$motivo$;

create function pg_temp.viva(p_sufijo text)
returns boolean language sql as $viva$
  select exists (select 1 from auth.sessions
                  where id = ('56000000-0000-4000-8000-0000000000' || p_sufijo)::uuid);
$viva$;

\ir ../migrations/0056_sesiones_limpieza_pg_cron.sql

-- 1. El job queda programado cada 5 min y llama a la limpieza.
select pg_temp.assert_true(
  (select count(*) = 1 from cron.job
    where jobname = 'sesiones_limpieza'
      and schedule = '*/5 * * * *'
      and command like '%public.sesiones_limpiar()%'),
  'pg_cron corre sesiones_limpiar cada 5 min'
);

-- 2. Nadie de la API ejecuta la limpieza; anon tampoco las funciones nuevas.
select pg_temp.como(null, null);
set role anon;
do $anon$
begin
  begin
    perform public.sesiones_limpiar();
    raise exception 'anon no debió poder limpiar';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.sesion_salir();
    raise exception 'anon no debió poder salir';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.sesiones_cerrar_demas();
    raise exception 'anon no debió poder cerrar las demás';
  exception when insufficient_privilege then null;
  end;
end
$anon$;
reset role;
set role authenticated;
do $auth$
begin
  begin
    perform public.sesiones_limpiar();
    raise exception 'authenticated no debió poder limpiar';
  exception when insufficient_privilege then null;
  end;
end
$auth$;
reset role;
select pg_temp.assert_true(
  not has_function_privilege('service_role', 'public.sesiones_limpiar()', 'execute'),
  'service_role tampoco ejecuta la limpieza: sólo pg_cron'
);

-- 3. Escenario de la limpieza (S4). Sufijo → caso:
--   01 sin «Recordarme», latido hace 8 h 5 min, inicio hace 10 h → inactividad
--   02 sin «Recordarme», latido hace 1 min, inicio hace 25 h → límite
--   03 sin «Recordarme», pestaña cerrada hace 6 min → pestaña cerrada
--   04 sin «Recordarme», pestaña cerrada hace 2 min → sigue
--   05 sin «Recordarme», latido hace 7 h 55 min, inicio hace 23 h → sigue
--   06 con «Recordarme», latido hace 2 días, inicio hace 3 días → sigue
--   07 con «Recordarme», latido hace 31 días, inicio hace 32 → inactividad
--      (con «Recordarme» no hay límite total, L40)
--   08 con «Recordarme», latido hace 1 min, inicio hace 31 días → sigue
--      (mientras se use, nunca se cierra)
--   09 con «Recordarme» y marca de pestaña vieja → sigue (no cuenta)
--   10 sin «Recordarme», latido hace 8 h 10 min, inicio hace 24 h 20 min →
--      límite (llega primero: hace 20 min, la inactividad hace 10)
--   11 sin fila, renovada hace 9 h (refreshed_at UTC) → inactividad
--   12 sin fila, inicio hace 2 h, renovada ahora → sigue
--   13 sin fila, inicio hace 25 h, renovada ahora → límite
--   14 sin fila, refreshed_at nulo, updated_at hace 9 h → inactividad
--   15 fila abierta sin sesión en auth.sessions → sesión terminada
--   16 de B, sin «Recordarme», latido hace 9 h → inactividad
--   17 fila ya cerrada hace 1 h (carrera) con la sesión aún viva y vencida →
--      se borra la sesión, pero la fila no se reescribe
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at, user_agent) values
  ('56000000-0000-4000-8000-000000000001', '56000000-0000-4000-8000-00000000000a', now() - interval '10 hours', now(), (now() at time zone 'utc'), 'UA-01'),
  ('56000000-0000-4000-8000-000000000002', '56000000-0000-4000-8000-00000000000a', now() - interval '25 hours', now(), (now() at time zone 'utc'), 'UA-02'),
  ('56000000-0000-4000-8000-000000000003', '56000000-0000-4000-8000-00000000000a', now() - interval '1 hour', now(), (now() at time zone 'utc'), 'UA-03'),
  ('56000000-0000-4000-8000-000000000004', '56000000-0000-4000-8000-00000000000a', now() - interval '1 hour', now(), (now() at time zone 'utc'), 'UA-04'),
  ('56000000-0000-4000-8000-000000000005', '56000000-0000-4000-8000-00000000000a', now() - interval '23 hours', now(), (now() at time zone 'utc'), 'UA-05'),
  ('56000000-0000-4000-8000-000000000006', '56000000-0000-4000-8000-00000000000a', now() - interval '3 days', now(), (now() at time zone 'utc'), 'UA-06'),
  ('56000000-0000-4000-8000-000000000007', '56000000-0000-4000-8000-00000000000a', now() - interval '32 days', now(), (now() at time zone 'utc'), 'UA-07'),
  ('56000000-0000-4000-8000-000000000008', '56000000-0000-4000-8000-00000000000a', now() - interval '31 days', now(), (now() at time zone 'utc'), 'UA-08'),
  ('56000000-0000-4000-8000-000000000009', '56000000-0000-4000-8000-00000000000a', now() - interval '2 days', now(), (now() at time zone 'utc'), 'UA-09'),
  ('56000000-0000-4000-8000-000000000010', '56000000-0000-4000-8000-00000000000a', now() - interval '24 hours 20 minutes', now(), (now() at time zone 'utc'), 'UA-10'),
  ('56000000-0000-4000-8000-000000000011', '56000000-0000-4000-8000-00000000000a', now() - interval '12 hours', now(), ((now() - interval '9 hours') at time zone 'utc'), 'UA-11'),
  ('56000000-0000-4000-8000-000000000012', '56000000-0000-4000-8000-00000000000a', now() - interval '2 hours', now(), (now() at time zone 'utc'), 'UA-12'),
  ('56000000-0000-4000-8000-000000000013', '56000000-0000-4000-8000-00000000000a', now() - interval '25 hours', now(), (now() at time zone 'utc'), 'UA-13'),
  ('56000000-0000-4000-8000-000000000014', '56000000-0000-4000-8000-00000000000a', now() - interval '12 hours', now() - interval '9 hours', null, 'UA-14'),
  ('56000000-0000-4000-8000-000000000016', '56000000-0000-4000-8000-00000000000b', now() - interval '10 hours', now(), (now() at time zone 'utc'), 'UA-16'),
  ('56000000-0000-4000-8000-000000000017', '56000000-0000-4000-8000-00000000000a', now() - interval '12 hours', now() - interval '9 hours', ((now() - interval '9 hours') at time zone 'utc'), 'UA-17');
insert into auth.refresh_tokens (token, user_id, session_id) values
  ('t01', '56000000-0000-4000-8000-00000000000a', '56000000-0000-4000-8000-000000000001'),
  ('t06', '56000000-0000-4000-8000-00000000000a', '56000000-0000-4000-8000-000000000006');

-- Las filas de presencia: refreshed_at = ahora a propósito en las que tienen
-- fila, para probar que manda el latido (el mismo «último uso» de la lista).
insert into public.sesiones_presencia
  (session_id, user_id, iniciada_en, ultimo_latido, pestana_cerrada_en, recordarme, ciudad, user_agent) values
  ('56000000-0000-4000-8000-000000000001', '56000000-0000-4000-8000-00000000000a', now() - interval '10 hours', now() - interval '8 hours 5 minutes', null, false, 'León', 'UA-01'),
  ('56000000-0000-4000-8000-000000000002', '56000000-0000-4000-8000-00000000000a', now() - interval '25 hours', now() - interval '1 minute', null, false, 'León', 'UA-02'),
  ('56000000-0000-4000-8000-000000000003', '56000000-0000-4000-8000-00000000000a', now() - interval '1 hour', now() - interval '6 minutes', now() - interval '6 minutes', false, 'León', 'UA-03'),
  ('56000000-0000-4000-8000-000000000004', '56000000-0000-4000-8000-00000000000a', now() - interval '1 hour', now() - interval '2 minutes', now() - interval '2 minutes', false, 'León', 'UA-04'),
  ('56000000-0000-4000-8000-000000000005', '56000000-0000-4000-8000-00000000000a', now() - interval '23 hours', now() - interval '7 hours 55 minutes', null, false, 'León', 'UA-05'),
  ('56000000-0000-4000-8000-000000000006', '56000000-0000-4000-8000-00000000000a', now() - interval '3 days', now() - interval '2 days', null, true, 'León', 'UA-06'),
  ('56000000-0000-4000-8000-000000000007', '56000000-0000-4000-8000-00000000000a', now() - interval '32 days', now() - interval '31 days', null, true, 'León', 'UA-07'),
  ('56000000-0000-4000-8000-000000000008', '56000000-0000-4000-8000-00000000000a', now() - interval '31 days', now() - interval '1 minute', null, true, 'León', 'UA-08'),
  ('56000000-0000-4000-8000-000000000009', '56000000-0000-4000-8000-00000000000a', now() - interval '2 days', now() - interval '1 hour', now() - interval '1 hour', true, 'León', 'UA-09'),
  ('56000000-0000-4000-8000-000000000010', '56000000-0000-4000-8000-00000000000a', now() - interval '24 hours 20 minutes', now() - interval '8 hours 10 minutes', null, false, 'León', 'UA-10'),
  ('56000000-0000-4000-8000-000000000015', '56000000-0000-4000-8000-00000000000a', now() - interval '2 hours', now() - interval '30 minutes', null, false, 'León', 'UA-15'),
  ('56000000-0000-4000-8000-000000000016', '56000000-0000-4000-8000-00000000000b', now() - interval '10 hours', now() - interval '9 hours', null, false, 'CDMX', 'UA-16');

-- Historial: cerrada hace 91 días (se purga) y hace 89 (se queda).
insert into public.sesiones_presencia
  (session_id, user_id, iniciada_en, ultimo_latido, user_agent, cerrada_en, motivo_cierre) values
  ('56000000-0000-4000-8000-000000000091', '56000000-0000-4000-8000-00000000000a', now() - interval '92 days', now() - interval '92 days', 'UA-91', now() - interval '91 days', 'inactividad'),
  ('56000000-0000-4000-8000-000000000089', '56000000-0000-4000-8000-00000000000a', now() - interval '90 days', now() - interval '90 days', 'UA-89', now() - interval '89 days', 'límite'),
  ('56000000-0000-4000-8000-000000000017', '56000000-0000-4000-8000-00000000000a', now() - interval '12 hours', now() - interval '9 hours', 'UA-17', now() - interval '1 hour', 'cerrada por ti');

select pg_temp.assert_true(
  public.sesiones_limpiar() = 10,
  'la limpieza devuelve cuántas sesiones borró de auth.sessions: 01, 02, 03, 07, 10, 11, 13, 14, 16 y 17'
);

select pg_temp.assert_true(
  pg_temp.motivo('01') = 'inactividad' and pg_temp.motivo('16') = 'inactividad'
    and pg_temp.motivo('07') = 'inactividad',
  'sin uso: 8 h sin «Recordarme» (01, 16 de B) y 30 días con él (07)'
);
select pg_temp.assert_true(
  pg_temp.motivo('02') = 'límite',
  'límite total: 24 h sin «Recordarme» (02)'
);
select pg_temp.assert_true(
  pg_temp.motivo('03') = 'pestaña cerrada',
  'pestaña cerrada hace más de 5 min sin «Recordarme» (03)'
);
select pg_temp.assert_true(
  pg_temp.motivo('10') = 'límite',
  'con dos límites vencidos, el motivo es el que llegó primero (10)'
);
select pg_temp.assert_true(
  pg_temp.motivo('11') = 'inactividad' and pg_temp.motivo('13') = 'límite'
    and pg_temp.motivo('14') = 'inactividad',
  'sin latido rigen las reglas sin «Recordarme» contra auth.sessions (11, 13, 14)'
);
select pg_temp.assert_true(
  (select user_id = '56000000-0000-4000-8000-00000000000a' and user_agent = 'UA-11'
      and pg_temp.cerca(iniciada_en, now() - interval '12 hours')
      and pg_temp.cerca(ultimo_latido, now() - interval '9 hours')
      and pg_temp.cerca(cerrada_en, now())
      and recordarme is null and ciudad is null
     from public.sesiones_presencia where session_id = '56000000-0000-4000-8000-000000000011'),
  'una sesión sin latido entra al historial con dueño, navegador, inicio y último uso (refreshed_at como UTC)'
);
select pg_temp.assert_true(
  pg_temp.motivo('15') = 'sesión terminada'
    and (select pg_temp.cerca(cerrada_en, now()) and ciudad = 'León'
           from public.sesiones_presencia where session_id = '56000000-0000-4000-8000-000000000015'),
  'una fila abierta cuya sesión ya no existe se cierra como «sesión terminada» (A3) y conserva sus datos'
);
select pg_temp.assert_true(
  pg_temp.motivo('04') = 'abierta' and pg_temp.motivo('05') = 'abierta'
    and pg_temp.motivo('06') = 'abierta' and pg_temp.motivo('09') = 'abierta'
    and pg_temp.motivo('12') = 'sin fila',
  'las que no pasan ningún límite siguen igual (04, 05, 06, 09, 12)'
);
select pg_temp.assert_true(
  pg_temp.motivo('08') = 'abierta' and pg_temp.viva('08'),
  'con «Recordarme» no hay límite total: en uso a los 31 días de iniciada sigue abierta (08)'
);
select pg_temp.assert_true(
  pg_temp.viva('04') and pg_temp.viva('05') and pg_temp.viva('06')
    and pg_temp.viva('08') and pg_temp.viva('09') and pg_temp.viva('12')
    and (select count(*) = 6 from auth.sessions)
    and exists (select 1 from auth.refresh_tokens where token = 't06')
    and not exists (select 1 from auth.refresh_tokens where token = 't01'),
  'en auth.sessions quedan sólo las 6 vivas; las cerradas se llevan sus refresh tokens'
);
select pg_temp.assert_true(
  not pg_temp.viva('17')
    and (select motivo_cierre = 'cerrada por ti' and cerrada_en < now() - interval '50 minutes'
           from public.sesiones_presencia where session_id = '56000000-0000-4000-8000-000000000017'),
  'una fila ya cerrada no se reescribe aunque la limpieza borre su sesión (17)'
);
select pg_temp.assert_true(
  not exists (select 1 from public.sesiones_presencia
               where session_id = '56000000-0000-4000-8000-000000000091')
    and pg_temp.motivo('89') = 'límite',
  'el historial de más de 90 días se purga; el de 89 se queda'
);

-- Correr de nuevo no cierra nada más ni reescribe los cierres.
select pg_temp.assert_true(
  public.sesiones_limpiar() = 0
    and pg_temp.motivo('10') = 'límite' and pg_temp.motivo('15') = 'sesión terminada',
  'una segunda corrida no cierra nada ni cambia motivos'
);

-- 4. S9: el latido de una sesión limpiada responde false.
select pg_temp.como('56000000-0000-4000-8000-00000000000a', '56000000-0000-4000-8000-000000000001');
set role authenticated;
select pg_temp.assert_true(
  public.sesion_latido(false, null, null, null, '{}') = false,
  'el latido de una sesión cerrada por la limpieza responde false'
);
reset role;

-- 5. «Cerrar las demás» (S3) como A desde la sesión 04.
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at, user_agent) values
  ('56000000-0000-4000-8000-000000000021', '56000000-0000-4000-8000-00000000000b', now() - interval '1 hour', now(), (now() at time zone 'utc'), 'UA-21');
select pg_temp.como('56000000-0000-4000-8000-00000000000a', null);
set role authenticated;
select pg_temp.assert_true(
  public.sesiones_cerrar_demas() = 0,
  'sin session_id no se cierra nada (no hay actual que proteger)'
);
reset role;
select pg_temp.como('56000000-0000-4000-8000-00000000000a', '56000000-0000-4000-8000-000000000004');
set role authenticated;
select pg_temp.assert_true(
  public.sesiones_cerrar_demas() = 5,
  'A cierra sus otras 5 sesiones (05, 06, 08, 09 y 12)'
);
reset role;
select pg_temp.assert_true(
  pg_temp.viva('04') and pg_temp.viva('21')
    and not pg_temp.viva('05') and not pg_temp.viva('06')
    and not pg_temp.viva('08') and not pg_temp.viva('09') and not pg_temp.viva('12')
    and not exists (select 1 from auth.refresh_tokens where token = 't06'),
  'sigue la actual (04) y la de B (21); las demás se borran con sus tokens'
);
select pg_temp.assert_true(
  pg_temp.motivo('05') = 'cerrada por ti' and pg_temp.motivo('06') = 'cerrada por ti'
    and pg_temp.motivo('08') = 'cerrada por ti' and pg_temp.motivo('09') = 'cerrada por ti' and pg_temp.motivo('12') = 'cerrada por ti'
    and pg_temp.motivo('04') = 'abierta' and pg_temp.motivo('10') = 'límite'
    and (select ciudad = 'León' from public.sesiones_presencia
          where session_id = '56000000-0000-4000-8000-000000000006')
    and (select user_agent = 'UA-12' and pg_temp.cerca(iniciada_en, now() - interval '2 hours')
           from public.sesiones_presencia where session_id = '56000000-0000-4000-8000-000000000012'),
  'quedan en el historial como «cerrada por ti», con o sin latido previo; los cierres viejos no cambian'
);

-- 6. «Cerrar sesión» (A3): la actual se cierra como «cerraste sesión».
select pg_temp.como('56000000-0000-4000-8000-00000000000a', null);
set role authenticated;
select pg_temp.assert_true(public.sesion_salir() = false, 'sin session_id no hay sesión que cerrar');
reset role;
select pg_temp.como('56000000-0000-4000-8000-00000000000a', '56000000-0000-4000-8000-000000000021');
set role authenticated;
select pg_temp.assert_true(public.sesion_salir() = false, 'una sesión ajena no se cierra');
reset role;
select pg_temp.assert_true(pg_temp.viva('21'), 'la sesión de B sigue');
select pg_temp.como('56000000-0000-4000-8000-00000000000a', '56000000-0000-4000-8000-000000000004');
set role authenticated;
select pg_temp.assert_true(public.sesion_salir(), 'A cierra su sesión actual');
select pg_temp.assert_true(public.sesion_salir() = false, 'salir dos veces devuelve false');
select pg_temp.assert_true(
  public.sesion_latido(false, null, null, null, '{}') = false,
  'tras salir, el latido responde false'
);
reset role;
select pg_temp.assert_true(
  not pg_temp.viva('04') and pg_temp.motivo('04') = 'cerraste sesión'
    and (select pg_temp.cerca(cerrada_en, now()) and ciudad = 'León'
           from public.sesiones_presencia where session_id = '56000000-0000-4000-8000-000000000004'),
  'la sesión se borra y queda en el historial como «cerraste sesión»'
);

-- Salir sin latido previo también deja historial.
select pg_temp.como('56000000-0000-4000-8000-00000000000b', '56000000-0000-4000-8000-000000000021');
set role authenticated;
select pg_temp.assert_true(public.sesion_salir(), 'B sale de una sesión sin latido');
reset role;
select pg_temp.assert_true(
  (select motivo_cierre = 'cerraste sesión' and user_id = '56000000-0000-4000-8000-00000000000b'
      and user_agent = 'UA-21'
     from public.sesiones_presencia where session_id = '56000000-0000-4000-8000-000000000021'),
  'sin latido previo, la sesión entra al historial como «cerraste sesión»'
);

-- 7. La lista muestra los motivos nuevos (S10).
select pg_temp.como('56000000-0000-4000-8000-00000000000a', '56000000-0000-4000-8000-000000000004');
set role authenticated;
select pg_temp.assert_true(
  (select count(*) = 1 from public.sesiones_listar()
    where motivo_cierre = 'sesión terminada'
      and id = '56000000-0000-4000-8000-000000000015')
    and (select count(*) = 1 from public.sesiones_listar()
          where motivo_cierre = 'cerraste sesión'),
  'en «Cerradas en los últimos 7 días» salen «sesión terminada» y «cerraste sesión»'
);
reset role;
select pg_temp.como(null, null);

-- 8. Reaplicar es seguro: un solo job, misma programación.
\ir ../migrations/0056_sesiones_limpieza_pg_cron.sql
select pg_temp.assert_true(
  (select count(*) = 1 from cron.job where jobname = 'sesiones_limpieza'),
  'al reaplicar sigue habiendo un solo job'
);
select pg_temp.assert_true(
  pg_temp.motivo('04') = 'cerraste sesión' and pg_temp.motivo('15') = 'sesión terminada',
  'al reaplicar el historial no cambia'
);

\echo 'OK 0056_sesiones_limpieza_pg_cron'
