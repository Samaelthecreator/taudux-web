-- Sesiones activas en «Acceso y seguridad»: ver en qué dispositivos tienes la
-- sesión abierta, cerrar las que no reconoces y ver las cerradas hace poco.
--
-- public.sesiones_presencia guarda lo que Supabase no sabe de cada sesión: el
-- latido de la pestaña (cada ~1 min), si la persona marcó «Recordarme» (esa
-- preferencia vive sólo en el navegador), cuándo cerró la pestaña, la
-- ubicación que calcula Vercel y el navegador con su versión (Client Hints).
-- No tiene llave foránea a auth.sessions a propósito: la fila sobrevive a su
-- sesión como historial (cerrada_en + motivo_cierre); 0056 la purga a los 90
-- días. Sin policies: sólo las funciones la tocan.
--
-- Por qué funciones y no lectura directa: auth.sessions no se expone a la API
-- y guarda la IP, que nunca se muestra. Las cuatro son security definer,
-- comprueban al dueño adentro con auth.uid() y sólo `authenticated` las
-- ejecuta; mismo patrón que qr_renombrar (0052).
--
-- La «sesión actual» sale del claim session_id del JWT. Sin ese claim no hay
-- sesión que latir ni actual que proteger: todo responde false.
--
-- Una fila cerrada no se reabre: el upsert del latido exige cerrada_en nulo.
-- Si un cierre (sesion_cerrar, o la limpieza de 0056) gana la carrera, el
-- latido espera su bloqueo, ve la fila cerrada y responde false (S9). Orden de
-- bloqueo de quien cierra: primero auth.sessions, después la presencia.
--
-- refreshed_at es `timestamp` SIN zona (GoTrue lo escribe en UTC); se lee con
-- `at time zone 'UTC'` para que no dependa de la zona de la conexión.
--
-- Al aplicar por primera vez se cierran TODAS las sesiones existentes (S11):
-- pasan al historial con motivo «cambio de sistema» y se borran de
-- auth.sessions. Reaplicar es seguro: ese paso sólo corre si la tabla no
-- existía al empezar.

begin;

do $preflight$
begin
  if to_regclass('auth.sessions') is null or to_regclass('auth.users') is null then
    raise exception using
      errcode = 'P0001',
      message = '0055 preflight failed: auth.sessions and auth.users are required';
  end if;

  if (select count(*) from information_schema.columns
       where table_schema = 'auth' and table_name = 'sessions'
         and column_name in ('id', 'user_id', 'created_at', 'updated_at',
                             'refreshed_at', 'user_agent')) <> 6 then
    raise exception using
      errcode = 'P0001',
      message = '0055 preflight failed: auth.sessions lacks a required column';
  end if;

  -- Todo lo de abajo lee refreshed_at como UTC sin zona; si GoTrue cambia el
  -- tipo, los «último uso» se correrían en silencio.
  if (select data_type from information_schema.columns
       where table_schema = 'auth' and table_name = 'sessions'
         and column_name = 'refreshed_at') <> 'timestamp without time zone' then
    raise exception using
      errcode = 'P0001',
      message = '0055 preflight failed: auth.sessions.refreshed_at is no longer timestamp without time zone';
  end if;

  -- En Supabase esto corre como `postgres`, que no es superusuario: sin estos
  -- permisos el cierre al aplicar o sesion_cerrar fallarían. Mejor aquí.
  if not has_table_privilege('auth.sessions', 'DELETE')
     or not has_table_privilege('auth.users', 'REFERENCES') then
    raise exception using
      errcode = 'P0001',
      message = '0055 preflight failed: current role needs DELETE on auth.sessions and REFERENCES on auth.users';
  end if;
end
$preflight$;

-- S11 sólo en la primera aplicación (local a esta transacción).
do $primera_vez$
begin
  perform pg_catalog.set_config(
    'taudux.sesiones_0055_primera_vez',
    (to_regclass('public.sesiones_presencia') is null)::text,
    true
  );
end
$primera_vez$;

create table if not exists public.sesiones_presencia (
  session_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  iniciada_en timestamptz not null,
  ultimo_latido timestamptz not null,
  pestana_cerrada_en timestamptz,
  recordarme boolean,
  ciudad text,
  region text,
  pais text,
  user_agent text,
  navegador text,
  navegador_version text,
  sistema text,
  sistema_version text,
  modelo text,
  cerrada_en timestamptz,
  motivo_cierre text,
  constraint sesiones_presencia_motivo_check check (
    motivo_cierre in ('cerrada por ti', 'inactividad', 'límite', 'pestaña cerrada', 'cambio de sistema')
  ),
  constraint sesiones_presencia_cierre_check check (
    (cerrada_en is null) = (motivo_cierre is null)
  )
);

create index if not exists sesiones_presencia_user_id_idx
  on public.sesiones_presencia (user_id);

alter table public.sesiones_presencia enable row level security;
revoke all on table public.sesiones_presencia from public, anon, authenticated;

-- Latido de la sesión del token (S7, S9, S13). true = la sesión sigue viva.
-- Ubicación, dispositivo y «Recordarme» nulos conservan lo ya guardado: el
-- cliente los manda una vez y después sólo late.
create or replace function public.sesion_latido(
  p_recordarme boolean,
  p_ciudad text,
  p_region text,
  p_pais text,
  p_dispositivo jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sesion uuid := nullif((select auth.jwt() ->> 'session_id'), '')::uuid;
  v_usuario uuid := (select auth.uid());
  v_iniciada timestamptz;
  v_user_agent text;
  v_d jsonb := case when pg_catalog.jsonb_typeof(p_dispositivo) = 'object'
                    then p_dispositivo else '{}'::jsonb end;
  v_ciudad text := pg_catalog.left(nullif(pg_catalog.btrim(p_ciudad), ''), 100);
  v_region text := pg_catalog.left(nullif(pg_catalog.btrim(p_region), ''), 100);
  v_pais text := pg_catalog.left(nullif(pg_catalog.btrim(p_pais), ''), 100);
  v_navegador text := pg_catalog.left(nullif(pg_catalog.btrim(v_d ->> 'navegador'), ''), 60);
  v_navegador_version text := pg_catalog.left(nullif(pg_catalog.btrim(v_d ->> 'navegador_version'), ''), 60);
  v_sistema text := pg_catalog.left(nullif(pg_catalog.btrim(v_d ->> 'sistema'), ''), 60);
  v_sistema_version text := pg_catalog.left(nullif(pg_catalog.btrim(v_d ->> 'sistema_version'), ''), 60);
  v_modelo text := pg_catalog.left(nullif(pg_catalog.btrim(v_d ->> 'modelo'), ''), 60);
begin
  if v_sesion is null then
    return false;
  end if;

  select s.created_at, s.user_agent
    into v_iniciada, v_user_agent
    from auth.sessions s
   where s.id = v_sesion and s.user_id = v_usuario;
  if not found then
    return false;
  end if;

  insert into public.sesiones_presencia as d (
    session_id, user_id, iniciada_en, ultimo_latido, recordarme,
    ciudad, region, pais, user_agent,
    navegador, navegador_version, sistema, sistema_version, modelo
  )
  values (
    v_sesion, v_usuario, coalesce(v_iniciada, now()), now(), coalesce(p_recordarme, false),
    v_ciudad, v_region, v_pais, v_user_agent,
    v_navegador, v_navegador_version, v_sistema, v_sistema_version, v_modelo
  )
  on conflict (session_id) do update
    set ultimo_latido = now(),
        pestana_cerrada_en = null,
        recordarme = coalesce(p_recordarme, d.recordarme),
        ciudad = coalesce(v_ciudad, d.ciudad),
        region = coalesce(v_region, d.region),
        pais = coalesce(v_pais, d.pais),
        user_agent = coalesce(v_user_agent, d.user_agent),
        navegador = coalesce(v_navegador, d.navegador),
        navegador_version = coalesce(v_navegador_version, d.navegador_version),
        sistema = coalesce(v_sistema, d.sistema),
        sistema_version = coalesce(v_sistema_version, d.sistema_version),
        modelo = coalesce(v_modelo, d.modelo)
    where d.cerrada_en is null and d.user_id = v_usuario;
  return found;
end;
$$;

-- La pestaña se cerró (pagehide). Sólo cuenta sin «Recordarme»; recargar no
-- cierra porque el latido siguiente borra la marca (S4).
create or replace function public.sesion_pestana_cerrada()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sesion uuid := nullif((select auth.jwt() ->> 'session_id'), '')::uuid;
begin
  if v_sesion is null then
    return false;
  end if;

  update public.sesiones_presencia
     set pestana_cerrada_en = now()
   where session_id = v_sesion
     and user_id = (select auth.uid())
     and cerrada_en is null
     and recordarme is false;
  return found;
end;
$$;

-- Sesiones de quien llama: las vivas (con o sin latido todavía) y las
-- cerradas en los últimos 7 días con su motivo (S10). Sin IP. El estado
-- («Activa ahora», «Sin señal», «Inactiva») y «Se cerrará» los calcula el
-- cliente con los tiempos de S4.
create or replace function public.sesiones_listar()
returns table (
  id uuid,
  es_actual boolean,
  iniciada_en timestamptz,
  ultimo_uso timestamptz,
  pestana_cerrada_en timestamptz,
  recordarme boolean,
  ciudad text,
  region text,
  pais text,
  user_agent text,
  navegador text,
  navegador_version text,
  sistema text,
  sistema_version text,
  modelo text,
  cerrada_en timestamptz,
  motivo_cierre text
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from (
    select
      s.id,
      coalesce(s.id::text = (select auth.jwt() ->> 'session_id'), false),
      coalesce(p.iniciada_en, s.created_at),
      coalesce(p.ultimo_latido, s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at),
      p.pestana_cerrada_en,
      p.recordarme,
      p.ciudad, p.region, p.pais,
      s.user_agent,
      p.navegador, p.navegador_version, p.sistema, p.sistema_version, p.modelo,
      null::timestamptz,
      null::text
    from auth.sessions s
    left join public.sesiones_presencia p
      on p.session_id = s.id and p.user_id = s.user_id and p.cerrada_en is null
    where s.user_id = (select auth.uid())
    union all
    select
      p.session_id, false, p.iniciada_en, p.ultimo_latido, p.pestana_cerrada_en,
      p.recordarme, p.ciudad, p.region, p.pais, p.user_agent,
      p.navegador, p.navegador_version, p.sistema, p.sistema_version, p.modelo,
      p.cerrada_en, p.motivo_cierre
    from public.sesiones_presencia p
    where p.user_id = (select auth.uid())
      and p.cerrada_en > now() - interval '7 days'
  ) as t (id, es_actual, iniciada_en, ultimo_uso, pestana_cerrada_en, recordarme,
          ciudad, region, pais, user_agent, navegador, navegador_version, sistema,
          sistema_version, modelo, cerrada_en, motivo_cierre)
  order by es_actual desc, cerrada_en desc nulls first, ultimo_uso desc;
$$;

-- Cierra UNA sesión propia que no sea la actual (S3, S5). Borrar la fila de
-- auth.sessions se lleva sus refresh tokens (cascada de GoTrue); el latido de
-- ese dispositivo recibe false y cierra sesión ahí (S9). Queda en el historial
-- aunque nunca haya dado latido.
create or replace function public.sesion_cerrar(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actual uuid := nullif((select auth.jwt() ->> 'session_id'), '')::uuid;
  v_cerradas integer;
begin
  if v_actual is null then
    return false;
  end if;

  with borrada as (
    delete from auth.sessions
     where id = p_id
       and user_id = (select auth.uid())
       and id <> v_actual
    returning id, user_id, created_at, updated_at, refreshed_at, user_agent
  ), historial as (
    insert into public.sesiones_presencia as d (
      session_id, user_id, iniciada_en, ultimo_latido, user_agent, cerrada_en, motivo_cierre
    )
    select b.id, b.user_id,
           coalesce(b.created_at, now()),
           coalesce(b.refreshed_at at time zone 'UTC', b.updated_at, b.created_at, now()),
           b.user_agent, now(), 'cerrada por ti'
      from borrada b
    on conflict (session_id) do update
      set cerrada_en = now(),
          motivo_cierre = 'cerrada por ti'
      where d.cerrada_en is null
  )
  select count(*) into v_cerradas from borrada;
  return v_cerradas > 0;
end;
$$;

revoke all on function public.sesion_latido(boolean, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.sesion_pestana_cerrada() from public, anon, authenticated;
revoke all on function public.sesiones_listar() from public, anon, authenticated;
revoke all on function public.sesion_cerrar(uuid) from public, anon, authenticated;
grant execute on function public.sesion_latido(boolean, text, text, text, jsonb) to authenticated;
grant execute on function public.sesion_pestana_cerrada() to authenticated;
grant execute on function public.sesiones_listar() to authenticated;
grant execute on function public.sesion_cerrar(uuid) to authenticated;

-- S11: "decido cerrar todas". Las sesiones de antes de este sistema pasan al
-- historial (sin ciudad ni «Recordarme», que nunca se supieron) y se cierran.
do $s11$
begin
  -- Sin el begin/commit del archivo la marca local ya se perdió: mejor fallar
  -- que saltarse el cierre en silencio.
  if coalesce(current_setting('taudux.sesiones_0055_primera_vez', true), '') not in ('true', 'false') then
    raise exception using
      errcode = 'P0001',
      message = '0055 failed: run the whole file as one transaction (S11 guard lost)';
  end if;

  if current_setting('taudux.sesiones_0055_primera_vez') = 'true' then
    insert into public.sesiones_presencia (
      session_id, user_id, iniciada_en, ultimo_latido, user_agent, cerrada_en, motivo_cierre
    )
    select s.id, s.user_id,
           coalesce(s.created_at, now()),
           coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at, now()),
           s.user_agent, now(), 'cambio de sistema'
      from auth.sessions s
    on conflict (session_id) do nothing;

    delete from auth.sessions;
  end if;
end
$s11$;

commit;
