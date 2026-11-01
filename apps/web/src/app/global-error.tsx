"use client";

import "~/styles/globals.css";

export default function GlobalError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body className="bg-canvas text-text p-8">
        <title>Weaver — something went wrong</title>
        <main role="alert" className="flex flex-col items-start gap-4">
          <h1 className="text-xl font-semibold">Weaver could not load</h1>
          <p>Please try again.</p>
          <button
            type="button"
            onClick={retry}
            className="bg-brand text-text-on-accent rounded px-4 py-2"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
