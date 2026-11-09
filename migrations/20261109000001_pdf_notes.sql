-- Handwritten notes, images, text boxes and inserted blank pages on top of a
-- PDF (the viewer's pen tools). Stored per user, beside the file rather than
-- in it: the original PDF is never modified (and may be a shared, linked
-- folder). `data` is the viewer's own JSON; export flattens it into a PDF.
BEGIN;

CREATE TABLE public.pdf_notes (
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    path text NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, path)
);

ALTER TABLE public.pdf_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY pdf_notes_user_isolation ON public.pdf_notes
    USING (user_id = current_setting('app.user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);

COMMIT;
