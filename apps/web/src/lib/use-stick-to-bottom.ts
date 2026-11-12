"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

export function useStickToBottom(contentRevision: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const jumpToLatest = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);
  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const next =
      element.scrollHeight - element.clientHeight - element.scrollTop <= 64;
    followingRef.current = next;
    setFollowing(next);
  }, []);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followingRef.current)
      element.scrollTop = element.scrollHeight;
  }, [contentRevision]);
  return { scrollRef, onScroll, following, jumpToLatest };
}
