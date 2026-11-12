-- PDF notes become shared per file: everyone who can open the same file on
-- disk (e.g. a course folder shared with a friend) draws on one set of notes.
-- `doc_key` is the file's resolved real path — two accounts that share a
-- linked folder resolve to the same key, private files never collide.
-- Access is checked in the app: the key is always derived server-side from
-- a path the requesting user can open (app/routers/notes.py).
-- `version` bumps on every change; clients poll it and send per-stroke ops,
-- so two people editing at once don't overwrite each other.
-- pdf_notes (per-user, pre-sharing) stays as the source for a lazy one-time
-- migration the first time a file's shared notes are opened.
BEGIN;

CREATE TABLE public.pdf_shared_notes (
    doc_key text PRIMARY KEY,
    data jsonb NOT NULL,
    version bigint NOT NULL DEFAULT 1,
    updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Not owned by one user, so no per-user policy; see the header for how access works.
ALTER TABLE public.pdf_shared_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY pdf_shared_notes_app_checked ON public.pdf_shared_notes
    USING (current_setting('app.user_id', true) IS NOT NULL)
    WITH CHECK (current_setting('app.user_id', true) IS NOT NULL);

COMMIT;
