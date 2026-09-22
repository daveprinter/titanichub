-- Admin/app settings
CREATE TABLE public.app_settings (
  key text PRIMARY KEY,
  value text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.app_settings TO service_role;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.app_settings (key, value) VALUES
  ('admin_code', '0000'),
  ('admin_email', 'vitralparts306@gmail.com'),
  ('fallback_verification_code', '4030'),
  ('whatsapp_number', '254713206306')
ON CONFLICT (key) DO NOTHING;

-- Licenses
CREATE TABLE public.licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  customer_label text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  plan text NOT NULL DEFAULT 'monthly',
  max_activations int NOT NULL DEFAULT 1,
  expires_at timestamptz,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.licenses TO service_role;
ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;

INSERT INTO public.licenses (code, customer_label, status, plan, max_activations, expires_at, notes) VALUES
  ('PLUTO-TEST-1234-5678', 'TEST ACCOUNT', 'active', 'lifetime', 5, NULL, 'Testing license');

-- Devices bound to licenses
CREATE TABLE public.license_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id uuid NOT NULL REFERENCES public.licenses(id) ON DELETE CASCADE,
  device_hash text NOT NULL,
  device_name text NOT NULL DEFAULT '',
  activated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (license_id, device_hash)
);
GRANT ALL ON public.license_devices TO service_role;
ALTER TABLE public.license_devices ENABLE ROW LEVEL SECURITY;

-- Activation / login history
CREATE TABLE public.license_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id uuid REFERENCES public.licenses(id) ON DELETE CASCADE,
  license_code text NOT NULL DEFAULT '',
  device_hash text NOT NULL DEFAULT '',
  event text NOT NULL,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX license_events_license_idx ON public.license_events (license_id, created_at DESC);
GRANT ALL ON public.license_events TO service_role;
ALTER TABLE public.license_events ENABLE ROW LEVEL SECURITY;

-- Admin sessions (code + email verification)
CREATE TABLE public.admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  verification_code text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '12 hours'
);
GRANT ALL ON public.admin_sessions TO service_role;
ALTER TABLE public.admin_sessions ENABLE ROW LEVEL SECURITY;