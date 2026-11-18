"use client";
import { useEffect, useRef, useState } from "react";
import type { AttemptTiming } from "@weaver/core/services/examAttempts";
import { queryErrorCode } from "~/lib/query-presentation";
import { api } from "~/trpc/react";
export type AnswerValue = { selectedChoiceIds: string[]; text: string | null };
type SavedAnswer = {
  value: AnswerValue;
  sequence: number;
  savedAt: Date | null;
};
export type AnswerSlot = SavedAnswer & {
  baseSequence: number;
  status: "idle" | "pending" | "saving" | "saved" | "error" | "conflict";
  attempts: number;
  closed?: boolean;
  conflictingAnswer?: SavedAnswer;
};
export type AutosaveAction =
  | { type: "edit"; questionId: string; value: AnswerValue }
  | {
      type: "saving" | "failed";
      questionId: string;
      sequence: number;
    }
  | { type: "saved"; questionId: string; sequence: number; savedAt: Date }
  | {
      type: "canonical";
      questionId: string;
      sequence: number;
      submittedValue: AnswerValue;
      answer: SavedAnswer;
    }
  | { type: "resolveConflict"; choice: "saved" | "draft"; questionId: string }
  | { type: "closed" };

function sameAnswer(left: AnswerValue, right: AnswerValue) {
  return (
    left.text === right.text &&
    left.selectedChoiceIds.length === right.selectedChoiceIds.length &&
    left.selectedChoiceIds.every((choice) =>
      right.selectedChoiceIds.includes(choice),
    )
  );
}

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
        status: s.status === "conflict" ? "conflict" : "pending",
        attempts: 0,
      },
    };
  if (action.type === "canonical") {
    const { answer } = action;
    if (sameAnswer(s.value, answer.value))
      return {
        ...state,
        [action.questionId]: {
          ...answer,
          baseSequence: answer.sequence,
          status: "saved",
          attempts: 0,
        },
      };
    if (
      s.sequence !== action.sequence &&
      answer.sequence === action.sequence &&
      sameAnswer(action.submittedValue, answer.value)
    )
      return {
        ...state,
        [action.questionId]: {
          ...s,
          baseSequence: answer.sequence,
          status: "pending",
          attempts: 0,
          savedAt: answer.savedAt,
        },
      };
    return {
      ...state,
      [action.questionId]: {
        ...s,
        status: "conflict",
        conflictingAnswer: answer,
      },
    };
  }
  if (action.type === "resolveConflict") {
    const { conflictingAnswer } = s;
    if (!conflictingAnswer) return state;
    const next: AnswerSlot =
      action.choice === "saved"
        ? {
            ...conflictingAnswer,
            baseSequence: conflictingAnswer.sequence,
            status: "saved",
            attempts: 0,
          }
        : {
            ...conflictingAnswer,
            baseSequence: conflictingAnswer.sequence,
            value: s.value,
            sequence: Math.max(conflictingAnswer.sequence + 1, s.sequence),
            status: "pending",
            attempts: 0,
          };
    return { ...state, [action.questionId]: next };
  }
  if (action.type === "saved") {
    if (action.sequence <= s.baseSequence) return state;
    return {
      ...state,
      [action.questionId]: {
        ...s,
        baseSequence: action.sequence,
        status: s.sequence === action.sequence ? "saved" : "pending",
        attempts: 0,
        savedAt: action.savedAt,
      },
    };
  }
  if (s.sequence !== action.sequence) return state;
  return {
    ...state,
    [action.questionId]: {
      ...s,
      status: action.type === "saving" ? "saving" : "error",
      attempts: action.type === "failed" ? s.attempts + 1 : s.attempts,
    },
  };
}
export function nextRetryDelayMs(attempts: number) {
  return Math.min(10000, 2000 * 2 ** Math.max(0, attempts - 1));
}
export function hasUnacknowledgedAnswers(slots: Record<string, AnswerSlot>) {
  return Object.values(slots).some(needsAcknowledgement);
}
function needsAcknowledgement(slot: AnswerSlot) {
  return slot.status !== "idle" && slot.status !== "saved";
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
  const retrying = useRef(new Map<string, AnswerSlot>());
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
    const latest = current.current[id];
    if (
      !latest ||
      closed.current ||
      !["pending", "error"].includes(latest.status)
    )
      return;
    const s = retrying.current.get(id) ?? latest;
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    dispatch({ type: "saving", questionId: id, sequence: latest.sequence });
    const work = (async () => {
      try {
        const result = await mutation.mutateAsync({
          attemptId: input.attemptId,
          questionId: id,
          baseSequence: s.baseSequence,
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
          const canonical = await utils.exam.getAttempt.fetch(
            { attemptId: input.attemptId },
            { staleTime: 0 },
          );
          const q = canonical.questions.find((q) => q.id === id);
          if (q?.answer && q.answer.sequence >= result.sequence)
            dispatch({
              type: "canonical",
              questionId: id,
              sequence: s.sequence,
              submittedValue: s.value,
              answer: {
                value: {
                  selectedChoiceIds: q.answer.selectedChoiceIds,
                  text: q.answer.text,
                },
                sequence: q.answer.sequence,
                savedAt: q.answer.savedAt,
              },
            });
          else throw new Error("Could not refresh the saved answer");
        } else {
          closed.current = true;
          dispatch({ type: "closed" });
          callbacks.current.onExpired();
        }
        retrying.current.delete(id);
      } catch (error) {
        if (queryErrorCode(error) === "BAD_REQUEST")
          retrying.current.delete(id);
        else retrying.current.set(id, s);
        dispatch({
          type: "failed",
          questionId: id,
          sequence: current.current[id]?.sequence ?? s.sequence,
        });
        const failed = current.current[id];
        if (failed && !closed.current && alive.current)
          schedule(id, nextRetryDelayMs(failed.attempts));
      }
    })();
    running.current.set(id, work);
    await work;
    running.current.delete(id);
    if (
      current.current[id]?.status === "pending" &&
      !closed.current &&
      alive.current
    )
      schedule(id, 0);
  }
  function edit(id: string, value: AnswerValue, delay: number) {
    if (closed.current) return;
    dispatch({ type: "edit", questionId: id, value });
    if (current.current[id]?.status === "pending") schedule(id, delay);
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
      if (Object.values(current.current).some((s) => s.status === "conflict"))
        throw new Error("Resolve the conflicting answers before submitting.");
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
    useSavedAnswer: (id: string) => {
      dispatch({ type: "resolveConflict", choice: "saved", questionId: id });
    },
    keepDraftAnswer: (id: string) => {
      dispatch({ type: "resolveConflict", choice: "draft", questionId: id });
      if (current.current[id]?.status === "pending") schedule(id, 0);
    },
    pendingCount: Object.values(slots).filter(needsAcknowledgement).length,
    lastSavedAt: Object.values(slots).reduce<Date | null>(
      (last, s) =>
        s.savedAt && (!last || s.savedAt > last) ? s.savedAt : last,
      null,
    ),
  };
}
