import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Header } from "@/components/layout/header";
import { api } from "@/lib/api";
import { PROVIDER_LABELS, useAiProviders, useDefaultProvider, type ProviderId } from "@/lib/ai";
import { useActiveCourses } from "@/lib/queries";
import { cn } from "@/lib/cn";

/* Daily recap quiz: the user's own AI writes questions from what they did
 * today, then grades the answers and lists gaps. Backend: app/routers/quiz.py. */

type Question = {
  id: number;
  type: "mcq" | "short";
  question: string;
  options: string[];
  answer: string;
  topic: string;
};
type Quiz = {
  title: string;
  questions: Question[];
  sources: { lectures: string[]; topics: string[]; files: string[]; asked: number; notes: boolean };
};
type Grade = {
  results: { id: number; correct: boolean; feedback: string }[];
  score: number;
  total: number;
  summary: string;
  gaps: string[];
  next_steps: string[];
};

const field = "rounded-md border border-border/60 bg-surface-2 px-3 py-2 text-sm";
const primary =
  "touch-target inline-flex items-center justify-center gap-2 rounded-md bg-fg text-bg px-4 text-sm font-medium disabled:opacity-50";

export default function QuizPage() {
  const { t } = useTranslation();
  const providers = useAiProviders();
  const courses = useActiveCourses();
  const [savedProvider, setSavedProvider] = useDefaultProvider();
  const installed = (providers.data?.providers ?? []).filter((p) => p.installed);
  const provider: ProviderId | undefined = installed.some((p) => p.id === savedProvider)
    ? savedProvider!
    : installed[0]?.id;

  const [course, setCourse] = useState("");
  const [count, setCount] = useState(6);
  const [notes, setNotes] = useState("");
  const [answers, setAnswers] = useState<Record<number, string>>({});

  const create = useMutation({
    mutationFn: () =>
      api.post<Quiz>("/api/ai/quiz/generate", {
        provider,
        course: course || undefined,
        notes: notes.trim() || undefined,
        count,
      }),
    onSuccess: () => {
      setAnswers({});
      check.reset();
    },
  });
  const check = useMutation({
    mutationFn: (quiz: Quiz) =>
      api.post<Grade>("/api/ai/quiz/grade", {
        provider,
        questions: quiz.questions,
        answers: quiz.questions.map((q) => answers[q.id] ?? ""),
      }),
  });

  const quiz = create.data;
  const grade = check.data;
  const resultFor = (id: number) => grade?.results.find((r) => r.id === id);
  const name = provider ? PROVIDER_LABELS[provider] : "";

  let body: React.ReactNode;
  if (providers.isPending) {
    body = <Loader2 className="h-5 w-5 animate-spin text-muted mx-auto" />;
  } else if (!providers.data?.local_mode || !provider) {
    body = <p className="card p-5 text-sm text-muted">{t("quiz.unavailable")}</p>;
  } else if (!quiz) {
    body = (
      <section className="card p-4 md:p-5 flex flex-col gap-4">
        <p className="text-sm text-muted">{t("quiz.intro")}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            {t("quiz.course")}
            <select value={course} onChange={(e) => setCourse(e.target.value)} className={field}>
              <option value="">{t("quiz.allCourses")}</option>
              {(courses.data ?? []).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.full_name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            {t("quiz.questions")}
            <select value={count} onChange={(e) => setCount(Number(e.target.value))} className={field}>
              {[4, 6, 8, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            {t("ai.provider")}
            <select value={provider} onChange={(e) => setSavedProvider(e.target.value as ProviderId)} className={field}>
              {installed.map((p) => (
                <option key={p.id} value={p.id}>
                  {PROVIDER_LABELS[p.id]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs text-muted">
          {t("quiz.notes")}
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder={t("quiz.notesPlaceholder")}
            className={cn(field, "resize-y")}
          />
        </label>
        {create.error && <p className="text-sm text-critical">{(create.error as Error).message}</p>}
        <button type="button" onClick={() => create.mutate()} disabled={create.isPending} className={cn(primary, "self-start")}>
          {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {create.isPending ? t("quiz.writing", { name }) : t("quiz.create")}
        </button>
      </section>
    );
  } else {
    const s = quiz.sources;
    const basedOn = [
      s.lectures.length && t("quiz.src.lectures", { count: s.lectures.length }),
      s.topics.length && t("quiz.src.topics", { count: s.topics.length }),
      s.files.length && t("quiz.src.files", { count: s.files.length }),
      s.asked && t("quiz.src.asked", { count: s.asked }),
      s.notes && t("quiz.src.notes"),
    ].filter(Boolean);
    body = (
      <>
        <section className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">{quiz.title}</h2>
            <p className="text-xs text-muted">{t("quiz.basedOn", { list: basedOn.join(" · ") })}</p>
          </div>
          <button
            type="button"
            onClick={() => create.reset()}
            className="touch-target inline-flex items-center gap-2 rounded-md border border-border/60 bg-surface-2 px-3 text-sm"
          >
            <RotateCcw className="h-4 w-4" /> {t("quiz.new")}
          </button>
        </section>

        {quiz.questions.map((q, i) => {
          const r = resultFor(q.id);
          return (
            <section key={q.id} className={cn("card p-4 md:p-5 flex flex-col gap-3", r && (r.correct ? "border-ok/60" : "border-critical/60"))}>
              <p className="text-sm font-medium">
                <span className="text-muted mr-2">{i + 1}.</span>
                {q.question}
              </p>
              {q.type === "mcq" ? (
                <div className="flex flex-col gap-1.5">
                  {q.options.map((opt) => (
                    <label key={opt} className="flex items-start gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name={`q${q.id}`}
                        value={opt}
                        checked={answers[q.id] === opt}
                        disabled={Boolean(grade)}
                        onChange={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                        className="mt-1"
                      />
                      <span>{opt}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <textarea
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                  disabled={Boolean(grade)}
                  rows={3}
                  placeholder={t("quiz.answerPlaceholder")}
                  className={cn(field, "resize-y")}
                />
              )}
              {r && (
                <div className="text-sm flex flex-col gap-1">
                  <p className={cn("flex items-center gap-1.5 font-medium", r.correct ? "text-ok" : "text-critical")}>
                    {r.correct ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
                    {r.correct ? t("quiz.correct") : t("quiz.incorrect")}
                  </p>
                  <p className="text-muted">{r.feedback}</p>
                  {!r.correct && <p className="text-muted">{t("quiz.expected", { answer: q.answer })}</p>}
                </div>
              )}
            </section>
          );
        })}

        {check.error && <p className="text-sm text-critical">{(check.error as Error).message}</p>}
        {!grade && (
          <button type="button" onClick={() => check.mutate(quiz)} disabled={check.isPending} className={cn(primary, "self-start")}>
            {check.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {check.isPending ? t("quiz.grading", { name }) : t("quiz.check")}
          </button>
        )}

        {grade && (
          <section className="card p-4 md:p-5 flex flex-col gap-3">
            <p className="text-2xl font-semibold">{t("quiz.score", { score: grade.score, total: grade.total })}</p>
            {grade.summary && <p className="text-sm">{grade.summary}</p>}
            {grade.gaps.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">{t("quiz.gaps")}</h3>
                <ul className="list-disc pl-5 text-sm flex flex-col gap-1">
                  {grade.gaps.map((g) => <li key={g}>{g}</li>)}
                </ul>
              </div>
            )}
            {grade.next_steps.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">{t("quiz.nextSteps")}</h3>
                <ul className="list-disc pl-5 text-sm flex flex-col gap-1">
                  {grade.next_steps.map((g) => <li key={g}>{g}</li>)}
                </ul>
              </div>
            )}
          </section>
        )}
      </>
    );
  }

  return (
    <>
      <Header title={t("quiz.title")} />
      <div className="px-4 md:px-8 py-4 md:py-6 max-w-[760px] mx-auto w-full flex flex-col gap-4">{body}</div>
    </>
  );
}
