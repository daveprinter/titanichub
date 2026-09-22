CREATE TABLE public.admin_login_attempts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  fingerprint TEXT NOT NULL DEFAULT 'unknown',
  success BOOLEAN NOT NULL DEFAULT false,
  kind TEXT NOT NULL DEFAULT 'admin_code',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX admin_login_attempts_fp_idx ON public.admin_login_attempts (fingerprint, created_at DESC);
GRANT ALL ON public.admin_login_attempts TO service_role;
ALTER TABLE public.admin_login_attempts ENABLE ROW LEVEL SECURITY;