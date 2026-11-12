"use client";
import { useEffect, useRef, useState } from "react";
import { formatRemaining } from "../../../_components/examPresentation";
export function AttemptTimer({
  deadlineAt,
  serverNow,
  receivedAt,
  onExpired,
}: {
  deadlineAt: Date;
  serverNow: Date;
  receivedAt: number;
  onExpired: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const fired = useRef(false);
  const remaining = Math.max(
    0,
    new Date(deadlineAt).getTime() -
      (now + new Date(serverNow).getTime() - receivedAt),
  );
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!remaining && !fired.current) {
      fired.current = true;
      onExpired();
    }
  }, [remaining, onExpired]);
  return (
    <>
      <span
        role="timer"
        className={remaining < 300000 ? "text-danger font-semibold" : ""}
      >
        {formatRemaining(remaining)}
      </span>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {remaining === 0
          ? "Time is up."
          : remaining <= 60000
            ? "1 minute remaining."
            : remaining <= 300000
              ? "5 minutes remaining."
              : ""}
      </span>
    </>
  );
}
