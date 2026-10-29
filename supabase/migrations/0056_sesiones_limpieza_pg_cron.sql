-- Las sesiones se cierran solas (S4) y el historial se purga a los 90 días
-- (S10). pg_cron llama a public.sesiones_limpiar() cada 5 min.
--
-- Tiempos de S4, sin «Recordarme» / con él:
--   * sin uso: 8 h / 30 días («último uso» = el mismo de sesiones_listar);
--   * límite total desde el inicio: 24 h / ninguno (L40: con «Recordarme»,
--     mientras se use, nunca se cierra);
--   * pestaña cerrada: 5 min después del aviso de pagehide (sólo sin él).
-- «La sesión se cierra con el límite que llegue primero»: el motivo es el del
-- plazo más antiguo. Con el cron cada 5 min el cierre llega hasta 5 min tarde.
-- Una sesión sin fila de presencia (aún sin latido) sigue las reglas sin
-- «Recordarme» contra auth.sessions (confirmado en L19).
--
-- Cuando GoTrue borra una sesión por su cuenta (caduca, o un «Cerrar sesión»
-- que no pasó por sesion_salir), su fila queda abierta sin sesión: la limpieza
-- la cierra como «sesión terminada» (A3). Sin eso, la purga nunca la tocaría.
--
-- Orden de bloqueo, igual que sesion_cerrar (0055): primero auth.sessions,
-- después la presencia (A4). Si un latido corre a la vez, espera el bloqueo
-- de la fila, la ve cerrada y responde false (S9). La limpieza salta las
-- sesiones que otro cierre tiene bloqueadas, así nunca se cruza con
-- sesiones_cerrar_demas borrando varias filas en otro orden.
--
-- Carreras aceptadas:
--   * un latido que llega justo cuando la sesión ya venció no la salva: la
--     limpieza la cierra igual, ese latido responde true y el siguiente false;
--   * el refresh de GoTrue bloquea refresh_tokens antes que sessions (al
--     revés que el borrado en cascada); si chocan, Postgres aborta la
--     limpieza por deadlock, se revierte el lote entero y la corrida
--     siguiente lo vuelve a intentar. Mismo orden que sesion_cerrar (0055).
--
-- También aquí, para que el historial diga quién cerró:
--   * sesion_salir(): «Cerrar sesión» de la pestaña actual, antes del signOut;
--   * sesiones_cerrar_demas(): «Cerrar las demás sesiones», en lugar de
--     signOut({ scope: 'others' }), que no deja motivo.
--
-- Reaplicar es seguro: el CHECK se reemplaza y el job se desprograma por
-- nombre antes de volver a programarse.

begin;

do $preflight$
begin
  if to_regclass('public.sesiones_presencia') is null
     or to_regprocedure('public.sesion_cerrar(uuid)') is null then
    raise exception using
      errcode = 'P0001',
      message = '0056 preflight failed: 0055 must be applied first';
  end if;

  -- `for update of s` exige UPDATE (de al menos una columna) además del
  -- DELETE que ya pide 0055. Sin él, el job fallaría cada 5 min en silencio
  -- (sólo quedaría en cron.job_run_details).
  if not has_table_privilege('auth.sessions', 'DELETE')
     or not has_any_column_privilege('auth.sessions', 'UPDATE') then
    raise exception using
      errcode = 'P0001',
      message = '0056 preflight failed: current role needs DELETE and UPDATE on auth.sessions';
  end if;

  if to_regprocedure('cron.schedule(text, text, text)') is null then
    raise exception using
      errcode = 'P0001',
      message = '0056 preflight failed: pg_cron extension is required';
  end if;
end
$preflight$;

alter table public.sesiones_presencia
  drop constraint if exists sesiones_presencia_motivo_check;
alter table public.sesiones_presencia
  add constraint sesiones_presencia_motivo_check check (
    motivo_cierre in ('cerrada por ti', 'cerraste sesión', 'inactividad', 'límite',
                      'pestaña cerrada', 'sesión terminada', 'cambio de sistema')
  );

-- Cierra lo que venció y devuelve cuántas sesiones borró de auth.sessions.
-- Sólo la corre pg_cron (como postgres); nadie de la API la ejecuta.
create or replace function public.sesiones_limpiar()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cerradas integer;
begin
  with vencidas as (
    select s.id, s.user_id, s.user_agent, u.uso, u.inicio, plazo.motivo
      from auth.sessions s
      left join public.sesiones_presencia p
        on p.session_id = s.id and p.user_id = s.user_id and p.cerrada_en is null
      cross join lateral (
        select coalesce(p.ultimo_latido, s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at) as uso,
               coalesce(p.iniciada_en, s.created_at) as inicio
      ) u
      cross join lateral (
        select x.motivo
          from (values
            (u.uso + case when p.recordarme then interval '30 days' else interval '8 hours' end, 'inactividad'),
            (case when p.recordarme is not true then u.inicio + interval '24 hours' end, 'límite'),
            (case when p.recordarme is not true then p.pestana_cerrada_en + interval '5 minutes' end, 'pestaña cerrada')
          ) as x (vence, motivo)
         where x.vence <= now()
         order by x.vence
         limit 1
      ) plazo
    -- Salta las sesiones que otro cierre ya bloqueó (sesion_cerrar,
    -- sesiones_cerrar_demas): no espera ni se cruza con ellos; la corrida
    -- siguiente las encuentra cerradas o las cierra.
       for update of s skip locked
  ), borrada as (
    delete from auth.sessions s
     using vencidas v
     where s.id = v.id
    returning v.id, v.user_id, v.user_agent, v.uso, v.inicio, v.motivo
  ), historial as (
    insert into public.sesiones_presencia as d (
      session_id, user_id, iniciada_en, ultimo_latido, user_agent, cerrada_en, motivo_cierre
    )
    select b.id, b.user_id, coalesce(b.inicio, now()), coalesce(b.uso, now()),
           b.user_agent, now(), b.motivo
      from borrada b
    on conflict (session_id) do update
      set cerrada_en = now(),
          motivo_cierre = excluded.motivo_cierre
      where d.cerrada_en is null
  )
  select count(*) into v_cerradas from borrada;

  -- A3: filas abiertas cuya sesión ya no existe.
  update public.sesiones_presencia p
     set cerrada_en = now(),
         motivo_cierre = 'sesión terminada'
   where p.cerrada_en is null
     and not exists (select 1 from auth.sessions s where s.id = p.session_id);

  delete from public.sesiones_presencia
   where cerrada_en < now() - interval '90 days';

  return v_cerradas;
end;
$$;

-- «Cerrar sesión» (A3): borra la sesión del token y la deja en el historial
-- como «cerraste sesión». El cliente hace después signOut({ scope: 'local' }).
create or replace function public.sesion_salir()
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
     where id = v_actual
       and user_id = (select auth.uid())
    returning id, user_id, created_at, updated_at, refreshed_at, user_agent
  ), historial as (
    insert into public.sesiones_presencia as d (
      session_id, user_id, iniciada_en, ultimo_latido, user_agent, cerrada_en, motivo_cierre
    )
    select b.id, b.user_id,
           coalesce(b.created_at, now()),
           coalesce(b.refreshed_at at time zone 'UTC', b.updated_at, b.created_at, now()),
           b.user_agent, now(), 'cerraste sesión'
      from borrada b
    on conflict (session_id) do update
      set cerrada_en = now(),
          motivo_cierre = 'cerraste sesión'
      where d.cerrada_en is null
  )
  select count(*) into v_cerradas from borrada;
  return v_cerradas > 0;
end;
$$;

-- «Cerrar las demás sesiones» (S3, S5): todas las propias menos la actual,
-- como «cerrada por ti». Devuelve cuántas cerró.
create or replace function public.sesiones_cerrar_demas()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actual uuid := nullif((select auth.jwt() ->> 'session_id'), '')::uuid;
  v_cerradas integer;
begin
  if v_actual is null then
    return 0;
  end if;

  with borrada as (
    delete from auth.sessions
     where user_id = (select auth.uid())
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
  return v_cerradas;
end;
$$;

revoke all on function public.sesiones_limpiar() from public, anon, authenticated, service_role;
revoke all on function public.sesion_salir() from public, anon, authenticated;
revoke all on function public.sesiones_cerrar_demas() from public, anon, authenticated;
grant execute on function public.sesion_salir() to authenticated;
grant execute on function public.sesiones_cerrar_demas() to authenticated;

-- Por jobid y no con cron.unschedule(text): algunas versiones de pg_cron fallan
-- si el nombre todavía no existe (0019).
select cron.unschedule(jobid)
from cron.job
where jobname = 'sesiones_limpieza';

select cron.schedule(
  'sesiones_limpieza',
  '*/5 * * * *',
  'select public.sesiones_limpiar()'
);

commit;
