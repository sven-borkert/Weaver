import "@fontsource-variable/hanken-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "~/styles/globals.css";

import { type Metadata } from "next";
import { headers } from "next/headers";
import { getSessionUser } from "~/server/auth";

import { ThemeProvider } from "~/app/_components/ThemeProvider";
import { Toaster } from "~/components/ui/sonner";
import { TooltipProvider } from "~/components/ui/tooltip";
import { withBasePath } from "~/lib/basePath";
import { HistoryStateTracker } from "~/lib/use-unsaved-changes-guard";
import { TRPCReactProvider } from "~/trpc/react";

export const metadata: Metadata = {
  title: "Weaver",
  description: "Multi-project knowledge & documentation platform",
  icons: [
    { rel: "icon", url: withBasePath("/favicon.svg"), type: "image/svg+xml" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const user = await getSessionUser(requestHeaders);
  const nonce = requestHeaders.get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <HistoryStateTracker />
        <ThemeProvider nonce={nonce}>
          <TooltipProvider>
            <TRPCReactProvider initialPrincipalId={user?.id ?? null}>
              {children}
            </TRPCReactProvider>
          </TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
