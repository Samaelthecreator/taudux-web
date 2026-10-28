\set ON_ERROR_STOP on

-- Destructive by design: run only in the isolated database named below.
do $guard$
begin
  if current_database() <> 'taudux_sesiones_activas_0055_test' then
    raise exception 'Refusing to run outside taudux_sesiones_activas_0055_test';
  end if;
end
$guard$;

-- Una zona distinta de UTC a propósito: refreshed_at no tiene zona y la
-- migración debe leerlo como UTC venga de donde venga la conexión.
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
-- funciones nuevas de public. Sin reproducirlo, un `revoke` olvidado en la
-- migración pasaría esta prueba y abriría la función en producción.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  email text
);

-- Las columnas de auth.sessions que la sonda T0 vio en producción. Ojo:
-- GoTrue guarda refreshed_at SIN zona horaria (en UTC) y created_at/updated_at
-- con zona; el stand-in respeta esa mezcla para que la migración la maneje.
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

-- auth.jwt()/auth.uid() leen el GUC que PostgREST fija por request, como en
-- Supabase: así las funciones corren por el camino real bajo `set role`.
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

create function pg_temp.assert_true(condition boolean, message text)
returns void language plpgsql as $assert$
begin
  if condition is distinct from true then
    raise exception 'assertion failed: %', message;
  end if;
end
$assert$;

-- Las fechas se comparan con un minuto de holgura: cada sentencia de psql es
-- su propia transacción y now() avanza entre ellas.
create function pg_temp.cerca(a timestamptz, b timestamptz)
returns boolean language sql as $cerca$
  select abs(extract(epoch from a - b)) < 60;
$cerca$;

-- Fija los claims del request: usuario y sesión del token.
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

-- A: dueña de casi todo · B: otra cuenta.
insert into auth.users (id, email) values
  ('55000000-0000-4000-8000-00000000000a', 'a@example.com'),
  ('55000000-0000-4000-8000-00000000000b', 'b@example.com');

-- Sesiones que ya existen al aplicar (S11): se cierran todas.
--   e1 de A, renovada hace 2 h (refreshed_at sin zona) · e2 de B, sin renovar.
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at, user_agent, ip) values
  ('55000000-0000-4000-8000-0000000000e1', '55000000-0000-4000-8000-00000000000a', now() - interval '3 days', now() - interval '5 hours', ((now() - interval '2 hours') at time zone 'utc'), 'UA-E1', '10.0.0.1'),
  ('55000000-0000-4000-8000-0000000000e2', '55000000-0000-4000-8000-00000000000b', now() - interval '2 days', now() - interval '1 day', null, 'UA-E2', '10.0.0.2');
insert into auth.refresh_tokens (token, user_id, session_id) values
  ('te1', '55000000-0000-4000-8000-00000000000a', '55000000-0000-4000-8000-0000000000e1');

\ir ../migrations/0055_sesiones_activas.sql

-- 1. S11: las sesiones existentes pasan al historial y se borran.
select pg_temp.assert_true(
  not exists (select 1 from auth.sessions) and not exists (select 1 from auth.refresh_tokens),
  'al aplicar se cierran todas las sesiones y sus refresh tokens'
);
select pg_temp.assert_true(
  (select count(*) = 2 from public.sesiones_presencia
    where motivo_cierre = 'cambio de sistema'
      and cerrada_en > now() - interval '1 minute'
      and ciudad is null and recordarme is null),
  'las dos quedan en el historial con motivo «cambio de sistema», sin ciudad ni «Recordarme»'
);
select pg_temp.assert_true(
  (select user_id = '55000000-0000-4000-8000-00000000000a'
      and user_agent = 'UA-E1'
      and pg_temp.cerca(iniciada_en, now() - interval '3 days')
      and ultimo_latido > now() - interval '3 hours'
      and ultimo_latido < now() - interval '1 hour'
     from public.sesiones_presencia where session_id = '55000000-0000-4000-8000-0000000000e1'),
  'el historial guarda dueño, navegador, inicio y último uso (refreshed_at leído como UTC)'
);
select pg_temp.assert_true(
  (select ultimo_latido > now() - interval '25 hours' and ultimo_latido < now() - interval '23 hours'
     from public.sesiones_presencia where session_id = '55000000-0000-4000-8000-0000000000e2'),
  'sin refreshed_at, el último uso cae a updated_at'
);

-- Sesiones nuevas, ya con el sistema puesto:
--   1 actual de A · 2 y 3 de A · 4 de A sin latido (renovada hace 2 h) · 9 de B.
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at, user_agent, ip) values
  ('55000000-0000-4000-8000-000000000001', '55000000-0000-4000-8000-00000000000a', now() - interval '2 hours', now(), (now() at time zone 'utc'), 'UA-1', '10.0.0.1'),
  ('55000000-0000-4000-8000-000000000002', '55000000-0000-4000-8000-00000000000a', now() - interval '1 hour', now(), (now() at time zone 'utc'), 'UA-2', '10.0.0.2'),
  ('55000000-0000-4000-8000-000000000003', '55000000-0000-4000-8000-00000000000a', now() - interval '5 days', now(), (now() at time zone 'utc'), 'UA-3', '10.0.0.3'),
  ('55000000-0000-4000-8000-000000000004', '55000000-0000-4000-8000-00000000000a', now() - interval '1 day', now() - interval '5 hours', ((now() - interval '2 hours') at time zone 'utc'), 'UA-4', '10.0.0.4'),
  ('55000000-0000-4000-8000-000000000009', '55000000-0000-4000-8000-00000000000b', now() - interval '1 day', now(), (now() at time zone 'utc'), 'UA-9', '10.0.0.9');
insert into auth.refresh_tokens (token, user_id, session_id) values
  ('t2', '55000000-0000-4000-8000-00000000000a', '55000000-0000-4000-8000-000000000002'),
  ('t9', '55000000-0000-4000-8000-00000000000b', '55000000-0000-4000-8000-000000000009');

-- 2. anon no ejecuta ninguna de las cuatro funciones.
select pg_temp.como(null, null);
set role anon;
do $anon$
begin
  begin
    perform public.sesion_latido(false, 'X', 'X', 'MX', '{}');
    raise exception 'anon no debió poder dar latido';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.sesion_pestana_cerrada();
    raise exception 'anon no debió poder marcar la pestaña';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.sesiones_listar();
    raise exception 'anon no debió poder listar';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.sesion_cerrar('55000000-0000-4000-8000-000000000002');
    raise exception 'anon no debió poder cerrar';
  exception when insufficient_privilege then null;
  end;
end
$anon$;
reset role;

-- 3. La tabla no se lee ni se escribe directo.
select pg_temp.assert_true(
  (select relrowsecurity from pg_class where oid = 'public.sesiones_presencia'::regclass),
  'la tabla tiene RLS'
);
set role authenticated;
do $tabla$
begin
  begin
    perform 1 from public.sesiones_presencia;
    raise exception 'authenticated no debió leer la tabla';
  exception when insufficient_privilege then null;
  end;
end
$tabla$;
reset role;

-- 4. Latido (S7, S13): crea la fila de la sesión del token.
select pg_temp.como('55000000-0000-4000-8000-00000000000a', '55000000-0000-4000-8000-000000000001');
set role authenticated;
select pg_temp.assert_true(
  public.sesion_latido(
    false, '  León ', 'GUA', 'MX',
    jsonb_build_object('navegador', 'Edge', 'navegador_version', '130',
                       'sistema', 'Android', 'sistema_version', '15',
                       'modelo', repeat('m', 200))
  ),
  'A da latido desde su sesión 1'
);
reset role;
select pg_temp.assert_true(
  (select user_id = '55000000-0000-4000-8000-00000000000a'
      and pg_temp.cerca(iniciada_en, now() - interval '2 hours')
      and pg_temp.cerca(ultimo_latido, now())
      and recordarme = false
      and ciudad = 'León' and region = 'GUA' and pais = 'MX'
      and user_agent = 'UA-1'
      and navegador = 'Edge' and navegador_version = '130'
      and sistema = 'Android' and sistema_version = '15'
      and pg_catalog.length(modelo) = 60
      and cerrada_en is null and motivo_cierre is null
     from public.sesiones_presencia where session_id = '55000000-0000-4000-8000-000000000001'),
  'la fila guarda inicio, latido, «Recordarme», ubicación recortada y dispositivo acotado'
);

-- Un latido sin ubicación ni dispositivo conserva los anteriores.
set role authenticated;
select pg_temp.assert_true(
  public.sesion_latido(null, null, null, null, '[]'),
  'un latido sin datos sigue respondiendo true'
);
reset role;
select pg_temp.assert_true(
  (select count(*) = 1
      and bool_and(ciudad = 'León' and navegador = 'Edge' and recordarme = false)
     from public.sesiones_presencia where session_id = '55000000-0000-4000-8000-000000000001'),
  'una sola fila por sesión; ubicación, dispositivo y «Recordarme» se conservan'
);

-- Sin sesión en el token, o con una que no existe o no es suya: false.
select pg_temp.como('55000000-0000-4000-8000-00000000000a', null);
set role authenticated;
select pg_temp.assert_true(
  public.sesion_latido(false, 'X', 'X', 'MX', '{}') = false,
  'sin session_id, el latido responde false'
);
reset role;
select pg_temp.como('55000000-0000-4000-8000-00000000000a', '55000000-0000-4000-8000-0000000000ff');
set role authenticated;
select pg_temp.assert_true(
  public.sesion_latido(false, 'X', 'X', 'MX', '{}') = false,
  'una sesión inexistente responde false'
);
reset role;
select pg_temp.como('55000000-0000-4000-8000-00000000000a', '55000000-0000-4000-8000-000000000009');
set role authenticated;
select pg_temp.assert_true(
  public.sesion_latido(false, 'X', 'X', 'MX', '{}') = false,
  'una sesión ajena responde false'
);
reset role;
select pg_temp.assert_true(
  not exists (select 1 from public.sesiones_presencia
               where session_id in ('55000000-0000-4000-8000-0000000000ff',
                                    '55000000-0000-4000-8000-000000000009')),
  'los latidos rechazados no crean filas'
);

-- 5. Pestaña cerrada (S4): sólo cuenta sin «Recordarme».
select pg_temp.como('55000000-0000-4000-8000-00000000000a', '55000000-0000-4000-8000-000000000002');
set role authenticated;
select pg_temp.assert_true(
  public.sesion_pestana_cerrada() = false,
  'sin latido previo no hay fila que marcar'
);
select pg_temp.assert_true(public.sesion_latido(false, null, null, null, '{}'), 'latido de la sesión 2');
select pg_temp.assert_true(public.sesion_pestana_cerrada(), 'la sesión 2 marca su pestaña cerrada');
reset role;
select pg_temp.assert_true(
  (select pg_temp.cerca(pestana_cerrada_en, now()) from public.sesiones_presencia
    where session_id = '55000000-0000-4000-8000-000000000002'),
  'se guarda cuándo se cerró la pestaña'
);
set role authenticated;
select pg_temp.assert_true(public.sesion_latido(false, null, null, null, '{}'), 'la sesión 2 vuelve (F5)');
reset role;
select pg_temp.assert_true(
  (select pestana_cerrada_en is null from public.sesiones_presencia
    where session_id = '55000000-0000-4000-8000-000000000002'),
  'el latido siguiente borra la marca de pestaña cerrada'
);

select pg_temp.como('55000000-0000-4000-8000-00000000000a', '55000000-0000-4000-8000-000000000003');
set role authenticated;
select pg_temp.assert_true(public.sesion_latido(true, 'Monterrey', 'NLE', 'MX', '{}'), 'latido de la sesión 3 con «Recordarme»');
select pg_temp.assert_true(
  public.sesion_pestana_cerrada() = false,
  'con «Recordarme», cerrar la pestaña no cuenta'
);
reset role;
select pg_temp.assert_true(
  (select pestana_cerrada_en is null and recordarme from public.sesiones_presencia
    where session_id = '55000000-0000-4000-8000-000000000003'),
  'la sesión 3 sigue sin marca'
);

-- Historial viejo de A (fuera de los 7 días) y cerrado de B.
insert into public.sesiones_presencia
  (session_id, user_id, iniciada_en, ultimo_latido, user_agent, cerrada_en, motivo_cierre) values
  ('55000000-0000-4000-8000-0000000000f1', '55000000-0000-4000-8000-00000000000a', now() - interval '10 days', now() - interval '9 days', 'UA-F1', now() - interval '8 days', 'inactividad');

-- 6. Listar como A desde la sesión 1.
select pg_temp.como('55000000-0000-4000-8000-00000000000a', '55000000-0000-4000-8000-000000000001');
set role authenticated;
create temp table lista_a as select * from public.sesiones_listar();
reset role;

select pg_temp.assert_true(
  (select array_agg(right(id::text, 2) order by right(id::text, 2)) from lista_a where cerrada_en is null)
    = array['01', '02', '03', '04'],
  'A ve sus sesiones vivas 1, 2, 3 y 4 (aún sin latido); no las de B'
);
select pg_temp.assert_true(
  (select array_agg(right(id::text, 2) || ':' || motivo_cierre) from lista_a where cerrada_en is not null)
    = array['e1:cambio de sistema'],
  'en cerradas, sólo e1 (dentro de 7 días); ni f1 (8 días) ni e2 (de B)'
);
select pg_temp.assert_true(
  (select right(id::text, 2) from lista_a limit 1) = '01'
    and (select count(*) = 1 from lista_a where es_actual),
  'la actual va primero y es la única marcada'
);
select pg_temp.assert_true(
  (select ultimo_uso > now() - interval '3 hours' and ultimo_uso < now() - interval '1 hour'
      and pg_temp.cerca(iniciada_en, now() - interval '1 day')
      and user_agent = 'UA-4' and recordarme is null and ciudad is null
     from lista_a where right(id::text, 2) = '04'),
  'sin latido: inicio y último uso salen de auth.sessions (refreshed_at como UTC)'
);
select pg_temp.assert_true(
  (select pg_temp.cerca(ultimo_uso, now()) and ciudad = 'Monterrey' and recordarme
     from lista_a where right(id::text, 2) = '03'),
  'con latido: último uso, ciudad y «Recordarme» salen de la presencia'
);
select pg_temp.assert_true(
  (select navegador = 'Edge' and navegador_version = '130' and sistema = 'Android' and sistema_version = '15'
     from lista_a where right(id::text, 2) = '01'),
  'la fila trae navegador y sistema con versión'
);
select pg_temp.assert_true(
  not exists (
    select 1 from information_schema.columns
     where table_schema like 'pg_temp%' and table_name = 'lista_a' and column_name = 'ip'
  ),
  'la IP nunca sale'
);

-- 7. Cerrar (S3, S5) como A desde la sesión 1.
set role authenticated;
select pg_temp.assert_true(
  public.sesion_cerrar('55000000-0000-4000-8000-000000000009') = false,
  'A no cierra la sesión de B'
);
select pg_temp.assert_true(
  public.sesion_cerrar('55000000-0000-4000-8000-000000000001') = false,
  'A no cierra su sesión actual'
);
select pg_temp.assert_true(
  public.sesion_cerrar('55000000-0000-4000-8000-000000000002'),
  'A cierra su sesión 2'
);
select pg_temp.assert_true(
  public.sesion_cerrar('55000000-0000-4000-8000-000000000002') = false,
  'cerrar dos veces devuelve false'
);
select pg_temp.assert_true(
  public.sesion_cerrar('55000000-0000-4000-8000-000000000004'),
  'A cierra su sesión 4, que nunca dio latido'
);
reset role;

select pg_temp.assert_true(
  exists (select 1 from auth.sessions where id = '55000000-0000-4000-8000-000000000009')
    and exists (select 1 from auth.refresh_tokens where token = 't9')
    and exists (select 1 from auth.sessions where id = '55000000-0000-4000-8000-000000000001'),
  'la sesión de B, su token y la sesión actual siguen'
);
select pg_temp.assert_true(
  not exists (select 1 from auth.sessions where id = '55000000-0000-4000-8000-000000000002')
    and not exists (select 1 from auth.refresh_tokens where token = 't2'),
  'cerrar borra la sesión y su refresh token'
);
select pg_temp.assert_true(
  (select pg_temp.cerca(cerrada_en, now()) and motivo_cierre = 'cerrada por ti' and ciudad is null and navegador is null
     from public.sesiones_presencia where session_id = '55000000-0000-4000-8000-000000000002')
    and (select pg_temp.cerca(cerrada_en, now()) and motivo_cierre = 'cerrada por ti'
                and user_agent = 'UA-4' and pg_temp.cerca(iniciada_en, now() - interval '1 day')
           from public.sesiones_presencia where session_id = '55000000-0000-4000-8000-000000000004'),
  'las dos quedan en el historial con motivo «cerrada por ti», con o sin latido previo'
);

-- Sin sesión en el token no se cierra nada (no hay «actual» que proteger).
select pg_temp.como('55000000-0000-4000-8000-00000000000a', null);
set role authenticated;
select pg_temp.assert_true(
  public.sesion_cerrar('55000000-0000-4000-8000-000000000003') = false,
  'sin session_id no cierra'
);
reset role;

-- 8. S9: la sesión cerrada recibe false en su latido y no revive.
select pg_temp.como('55000000-0000-4000-8000-00000000000a', '55000000-0000-4000-8000-000000000002');
set role authenticated;
select pg_temp.assert_true(
  public.sesion_latido(false, 'X', 'X', 'MX', '{}') = false,
  'el latido de una sesión cerrada responde false'
);
reset role;
select pg_temp.assert_true(
  (select motivo_cierre = 'cerrada por ti' and ciudad is null
     from public.sesiones_presencia where session_id = '55000000-0000-4000-8000-000000000002'),
  'la fila cerrada no se reabre ni se reescribe'
);

-- La carrera con un cierre: el latido ya vio la sesión viva y el cierre se
-- confirma antes del upsert. Se reproduce ese estado (sesión aún en
-- auth.sessions, fila ya cerrada): el latido no la reabre.
insert into auth.sessions (id, user_id, created_at, updated_at, user_agent) values
  ('55000000-0000-4000-8000-000000000005', '55000000-0000-4000-8000-00000000000a', now() - interval '1 day', now(), 'UA-5');
insert into public.sesiones_presencia
  (session_id, user_id, iniciada_en, ultimo_latido, user_agent, cerrada_en, motivo_cierre) values
  ('55000000-0000-4000-8000-000000000005', '55000000-0000-4000-8000-00000000000a', now() - interval '1 day', now() - interval '9 hours', 'UA-5', now(), 'inactividad');
select pg_temp.como('55000000-0000-4000-8000-00000000000a', '55000000-0000-4000-8000-000000000005');
set role authenticated;
select pg_temp.assert_true(
  public.sesion_latido(false, 'X', 'X', 'MX', '{}') = false,
  'un latido que pierde la carrera con el cierre responde false'
);
reset role;
select pg_temp.assert_true(
  (select motivo_cierre = 'inactividad' and ciudad is null
      and ultimo_latido < now() - interval '8 hours'
     from public.sesiones_presencia where session_id = '55000000-0000-4000-8000-000000000005'),
  'la fila cerrada en la carrera sigue cerrada y sin reescribir'
);
delete from auth.sessions where id = '55000000-0000-4000-8000-000000000005';

-- B sólo ve lo suyo, incluido su historial.
select pg_temp.como('55000000-0000-4000-8000-00000000000b', '55000000-0000-4000-8000-000000000009');
set role authenticated;
select pg_temp.assert_true(
  (select array_agg(right(id::text, 2) order by right(id::text, 2)) from public.sesiones_listar())
    = array['09', 'e2'],
  'B sólo ve su sesión y su historial'
);
reset role;
select pg_temp.como(null, null);

-- 9. Reaplicar no vuelve a cerrar todo: S11 corre una sola vez.
\ir ../migrations/0055_sesiones_activas.sql
select pg_temp.assert_true(
  (select count(*) = 3 from auth.sessions),
  'al reaplicar, las sesiones 1, 3 y 9 siguen abiertas'
);
select pg_temp.assert_true(
  (select count(*) = 2 from public.sesiones_presencia where motivo_cierre = 'cambio de sistema'),
  'al reaplicar no se agregan cierres por «cambio de sistema»'
);

\echo 'OK 0055_sesiones_activas'
