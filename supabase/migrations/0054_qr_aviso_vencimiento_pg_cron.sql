-- Programa el aviso de vencimiento de QR (0053) en pg_cron: cada hora llama a
-- la edge function avisar-vencimiento-qr. Mismo motivo que 0019/0045 para no
-- usar el cron de GitHub Actions: se salteaba ~7 de cada 8 corridas.
--
-- Por qué cada hora y no una vez al día: la función avisa a los QR que vencen
-- en las próximas 24 h. Con una corrida diaria el aviso podía llegar minutos
-- antes del vencimiento; cada hora llega entre 23 y 24 h antes.
--
-- Mismas cabeceras que qr_revision_diaria (0045):
--
-- * x-taudux-qr-secret autoriza la llamada (comparada en tiempo constante en
--   avisar-vencimiento-qr/index.ts). Reutiliza el secreto `qr_cron_secret` de
--   Vault: el mismo valor que el secret QR_CRON_SECRET de las edge functions.
--   NO vive en este archivo: el repositorio es público.
-- * La anon key del Authorization no es secreta: ya se sirve a cada visitante
--   en src/app/core/supabase/supabase-client.js, y sólo satisface el chequeo
--   de JWT de la plataforma.
--
-- Antes de correr este archivo: aplicar 0053, desplegar la edge function, y
-- verificar que el proyecto destino es yqkvgfqplmbbcebrivpt.
--
-- Aplicar dos veces es seguro: el job se desprograma por nombre antes de
-- volver a programarse.

begin;

do $preflight$
begin
  if to_regprocedure('public.qr_avisos_vencimiento_pendientes(integer)') is null then
    raise exception using
      errcode = 'P0001',
      message = '0054 preflight failed: 0053 must be applied first';
  end if;

  if to_regprocedure('cron.schedule(text, text, text)') is null then
    raise exception using
      errcode = 'P0001',
      message = '0054 preflight failed: pg_cron extension is required';
  end if;

  if to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
    raise exception using
      errcode = 'P0001',
      message = '0054 preflight failed: pg_net extension is required';
  end if;

  if not exists (
    select 1 from vault.decrypted_secrets where name = 'qr_cron_secret'
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0054 preflight failed: vault secret qr_cron_secret is required';
  end if;
end
$preflight$;

-- Por jobid y no con cron.unschedule(text): algunas versiones de pg_cron fallan
-- si el nombre todavía no existe, y eso rompería la primera aplicación (0019).
select cron.unschedule(jobid)
from cron.job
where jobname = 'qr_aviso_vencimiento';

-- Al minuto 5 de cada hora: lejos de la purga (09:15) y la revisión (09:45).
select cron.schedule(
  'qr_aviso_vencimiento',
  '5 * * * *',
  $cron$
  select net.http_post(
    url := 'https://yqkvgfqplmbbcebrivpt.supabase.co/functions/v1/avisar-vencimiento-qr',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- Public anon key, matches src/app/core/supabase/supabase-client.js.
      -- Satisfies the platform JWT check only; grants no authorization.
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlxa3ZnZnFwbG1iYmNlYnJpdnB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0ODgxOTEsImV4cCI6MjEwMDA2NDE5MX0.wU-ylZ6agwkochwmOGe-7BROByw1qsvYpmqT5xDvF1Y',
      'x-taudux-qr-secret', (
        select decrypted_secret from vault.decrypted_secrets where name = 'qr_cron_secret'
      )
    ),
    body := '{}'::jsonb,
    -- Un solo lote de hasta 100 correos a Resend: 30 s sobran.
    timeout_milliseconds := 30000
  );
  $cron$
);

commit;
