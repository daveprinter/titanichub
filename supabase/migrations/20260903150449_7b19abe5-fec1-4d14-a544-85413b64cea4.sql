ALTER TABLE public.admin_sessions ADD COLUMN IF NOT EXISTS code_sent_at timestamptz;
UPDATE public.admin_sessions SET code_sent_at = created_at WHERE code_sent_at IS NULL;