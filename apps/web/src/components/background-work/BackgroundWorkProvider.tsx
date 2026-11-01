"use client";

import type { BackgroundWorkSummary } from "@weaver/core/jobs/backgroundWorkSchema";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Dialog } from "~/components/ui/dialog";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { workPollInterval } from "~/lib/background-work/presentation";
import { api, usePrincipalId } from "~/trpc/react";
import { BackgroundWorkTray } from "./BackgroundWorkTray";

export type BackgroundWorkContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  summary: BackgroundWorkSummary | undefined;
  summaryUnavailable: boolean;
  refreshSummary: () => Promise<void>;
  pageVisible: boolean;
  openGeneration: number;
  openedAt: number;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
};

const BackgroundWorkContext = createContext<BackgroundWorkContextValue | null>(
  null,
);

export function useBackgroundWork(): BackgroundWorkContextValue {
  const value = useContext(BackgroundWorkContext);
  if (!value)
    throw new Error(
      "useBackgroundWork must be used within BackgroundWorkProvider",
    );
  return value;
}

export function BackgroundWorkProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const principalId = usePrincipalId();
  return (
    <PrincipalBackgroundWorkProvider key={principalId ?? "anonymous"}>
      {children}
    </PrincipalBackgroundWorkProvider>
  );
}

function PrincipalBackgroundWorkProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpenState] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [openGeneration, setOpenGeneration] = useState(0);
  const [openedAt, setOpenedAt] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousPathname = useRef(pathname);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (pathname !== previousPathname.current) {
      previousPathname.current = pathname;
      setOpenState(false);
    }
  }, [pathname]);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (next) {
      setOpenGeneration((value) => value + 1);
      setOpenedAt(Date.now());
    }
  }, []);

  const summaryQuery = api.backgroundWork.summary.useQuery(undefined, {
    retry: false,
    refetchInterval: (query) =>
      workPollInterval({
        open,
        active: (query.state.data?.active.value ?? 0) > 0,
        hidden: !pageVisible,
      }),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const summary = dataUnlessAccessError(summaryQuery.data, summaryQuery.error);
  const refreshSummary = useCallback(async () => {
    await summaryQuery.refetch();
  }, [summaryQuery]);
  const value = useMemo(
    () => ({
      open,
      setOpen,
      summary,
      summaryUnavailable: Boolean(summaryQuery.error),
      refreshSummary,
      pageVisible,
      openGeneration,
      openedAt,
      triggerRef,
    }),
    [
      open,
      setOpen,
      summary,
      summaryQuery.error,
      refreshSummary,
      pageVisible,
      openGeneration,
      openedAt,
    ],
  );

  return (
    <BackgroundWorkContext.Provider value={value}>
      <Dialog open={open} onOpenChange={setOpen}>
        {children}
        <BackgroundWorkTray />
      </Dialog>
    </BackgroundWorkContext.Provider>
  );
}
