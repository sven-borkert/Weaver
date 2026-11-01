import Link from "next/link";

export default function NotFound() {
  return (
    <main className="text-text flex flex-col items-start gap-3 p-6">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p>This page does not exist or you no longer have access.</p>
      <Link href="/" className="text-brand-text underline">
        Return to Weaver
      </Link>
    </main>
  );
}
