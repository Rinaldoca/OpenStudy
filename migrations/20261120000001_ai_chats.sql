-- Ask AI conversations, saved and shared. Every account with AI access
-- (storage.ai_access: the operator, or everyone with AI_USERS=all) sees and
-- can continue every chat — it is one common list for the people sharing
-- this instance's AI subscriptions. Access is checked in the app
-- (app/routers/ai_chats.py), as for pdf_shared_notes.
-- Pasted images are stored in ai_chat_images (bytea, ≤ 5 MB each, checked in the app).
BEGIN;

CREATE TABLE public.ai_chats (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL DEFAULT '',
    created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_chats_updated_idx ON public.ai_chats (updated_at DESC);

CREATE TABLE public.ai_chat_messages (
    id bigserial PRIMARY KEY,
    chat_id uuid NOT NULL REFERENCES public.ai_chats(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('user', 'assistant', 'error')),
    content text NOT NULL,
    author uuid REFERENCES public.users(id) ON DELETE SET NULL,
    provider text,
    model text,
    -- What the question was about: {path?, page?, selection?}
    context jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_chat_messages_chat_idx ON public.ai_chat_messages (chat_id, id);

CREATE TABLE public.ai_chat_images (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id bigint NOT NULL REFERENCES public.ai_chat_messages(id) ON DELETE CASCADE,
    mime text NOT NULL,
    data bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_chat_images_message_idx ON public.ai_chat_images (message_id);

ALTER TABLE public.ai_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_chat_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_chats_app_checked ON public.ai_chats
    USING (current_setting('app.user_id', true) IS NOT NULL)
    WITH CHECK (current_setting('app.user_id', true) IS NOT NULL);
CREATE POLICY ai_chat_messages_app_checked ON public.ai_chat_messages
    USING (current_setting('app.user_id', true) IS NOT NULL)
    WITH CHECK (current_setting('app.user_id', true) IS NOT NULL);
CREATE POLICY ai_chat_images_app_checked ON public.ai_chat_images
    USING (current_setting('app.user_id', true) IS NOT NULL)
    WITH CHECK (current_setting('app.user_id', true) IS NOT NULL);

COMMIT;
