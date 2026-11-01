"use client";
import { useEffect, useRef, useState } from "react";
import type { AttemptTiming } from "@weaver/core/services/examAttempts";
import { api } from "~/trpc/react";
export type AnswerValue = { selectedChoiceIds: string[]; text: string | null };
export type AnswerSlot = {
  value: AnswerValue;
  status: "idle" | "pending" | "saving" | "saved" | "error";
  sequence: number;
  savedAt: Date | null;
  attempts: number;
  closed?: boolean;
};
export type AutosaveAction =
  | { type: "edit"; questionId: string; value: AnswerValue }
  | {
      type: "saving" | "stale" | "failed";
      questionId: string;
      sequence: number;
    }
  | { type: "saved"; questionId: string; sequence: number; savedAt: Date }
  | {
      type: "canonical";
      questionId: string;
      sequence: number;
      slot: AnswerSlot;
    }
  | { type: "closed" };
export function autosaveReducer(
  state: Record<string, AnswerSlot>,
  action: AutosaveAction,
): Record<string, AnswerSlot> {
  if (action.type === "closed")
    return Object.fromEntries(
      Object.entries(state).map(([id, s]) => [id, { ...s, closed: true }]),
    );
  const s = state[action.questionId];
  if (!s || s.closed) return state;
  if (action.type === "edit")
    return {
      ...state,
      [action.questionId]: {
        ...s,
        value: action.value,
        sequence: s.sequence + 1,
        status: "pending",
        attempts: 0,
      },
    };
  if (s.sequence !== action.sequence) return state;
  if (action.type === "canonical")
    return { ...state, [action.questionId]: action.slot };
  return {
    ...state,
    [action.questionId]: {
      ...s,
      status:
        action.type === "saving"
          ? "saving"
          : action.type === "failed"
            ? "error"
            : "saved",
      attempts: action.type === "failed" ? s.attempts + 1 : s.attempts,
      savedAt: action.type === "saved" ? action.savedAt : s.savedAt,
    },
  };
}
export function nextRetryDelayMs(attempts: number) {
  return Math.min(10000, 2000 * 2 ** Math.max(0, attempts - 1));
}
export function hasUnacknowledgedAnswers(slots: Record<string, AnswerSlot>) {
  return Object.values(slots).some((s) =>
    ["pending", "saving", "error"].includes(s.status),
  );
}
export function useAutosaveAnswers(input: {
  attemptId: string;
  initial: Record<string, AnswerSlot>;
  onTiming: (t: AttemptTiming) => void;
  onExpired: () => void;
}) {
  const [slots, setSlots] = useState(input.initial);
  const current = useRef(slots);
  const callbacks = useRef(input);
  callbacks.current = input;
  const alive = useRef(true);
  const closed = useRef(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const running = useRef(new Map<string, Promise<void>>());
  const mutation = api.exam.saveAnswer.useMutation();
  const utils = api.useUtils();
  function dispatch(a: AutosaveAction) {
    current.current = autosaveReducer(current.current, a);
    if (alive.current) setSlots(current.current);
  }
  function schedule(id: string, delay: number) {
    const old = timers.current.get(id);
    if (old) clearTimeout(old);
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        void save(id);
      }, delay),
    );
  }
  async function save(id: string): Promise<void> {
    const existing = running.current.get(id);
    if (existing) {
      await existing;
      return;
    }
    const s = current.current[id];
    if (!s || closed.current || !["pending", "error"].includes(s.status))
      return;
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    dispatch({ type: "saving", questionId: id, sequence: s.sequence });
    const work = (async () => {
      try {
        const result = await mutation.mutateAsync({
          attemptId: input.attemptId,
          questionId: id,
          sequence: s.sequence,
          ...s.value,
        });
        callbacks.current.onTiming(result.timing);
        if (result.outcome === "saved")
          dispatch({
            type: "saved",
            questionId: id,
            sequence: s.sequence,
            savedAt: result.savedAt ?? new Date(),
          });
        else if (result.outcome === "stale") {
          const canonical = await utils.exam.getAttempt.fetch({
            attemptId: input.attemptId,
          });
          const q = canonical.questions.find((q) => q.id === id);
          if (q?.answer)
            dispatch({
              type: "canonical",
              questionId: id,
              sequence: s.sequence,
              slot: {
                value: {
                  selectedChoiceIds: q.answer.selectedChoiceIds,
                  text: q.answer.text,
                },
                sequence: q.answer.sequence,
                savedAt: q.answer.savedAt,
                status: "saved",
                attempts: 0,
              },
            });
          else throw new Error("Could not refresh the saved answer");
        } else {
          closed.current = true;
          dispatch({ type: "closed" });
          callbacks.current.onExpired();
        }
      } catch {
        dispatch({ type: "failed", questionId: id, sequence: s.sequence });
        const latest = current.current[id];
        if (latest && !closed.current && alive.current)
          schedule(id, nextRetryDelayMs(latest.attempts));
      }
    })();
    running.current.set(id, work);
    await work;
    running.current.delete(id);
    const latest = current.current[id];
    if (latest?.status === "pending" && !closed.current && alive.current)
      schedule(id, 0);
  }
  function edit(id: string, value: AnswerValue, delay: number) {
    if (closed.current) return;
    dispatch({ type: "edit", questionId: id, value });
    schedule(id, delay);
  }
  async function flush() {
    const until = Date.now() + 9000;
    while (hasUnacknowledgedAnswers(current.current)) {
      if (closed.current)
        throw new Error(
          "The attempt has closed before every answer was acknowledged",
        );
      if (Date.now() >= until)
        throw new Error(
          "Some answers could not be saved. Retry before submitting.",
        );
      await Promise.all(Object.keys(current.current).map(save));
      if (hasUnacknowledgedAnswers(current.current))
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  useEffect(() => {
    alive.current = true;
    const scheduled = timers.current;
    return () => {
      alive.current = false;
      for (const t of scheduled.values()) clearTimeout(t);
    };
  }, []);
  return {
    slots,
    setChoices: (id: string, ids: string[]) => {
      const s = current.current[id];
      if (s) edit(id, { ...s.value, selectedChoiceIds: ids }, 0);
    },
    setText: (id: string, text: string) => {
      const s = current.current[id];
      if (s) edit(id, { ...s.value, text }, 750);
    },
    flush,
    pendingCount: Object.values(slots).filter((s) =>
      ["pending", "saving", "error"].includes(s.status),
    ).length,
    lastSavedAt: Object.values(slots).reduce<Date | null>(
      (last, s) =>
        s.savedAt && (!last || s.savedAt > last) ? s.savedAt : last,
      null,
    ),
  };
}
