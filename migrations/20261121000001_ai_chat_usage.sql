-- Token usage per AI answer, as reported by the CLI:
-- {input, output, cache_read, thinking, model}. NULL for older answers and errors.
BEGIN;
ALTER TABLE public.ai_chat_messages ADD COLUMN usage jsonb;
COMMIT;
