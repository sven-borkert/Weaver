import { redirect } from "next/navigation";
export type LegacySearchParams = Record<string, string | string[] | undefined>;
export async function redirectToSettings(
  tab: "ai" | "remote-instances",
  searchParams: Promise<LegacySearchParams>,
): Promise<never> {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value))
      for (const entry of value) params.append(name, entry);
    else if (value !== undefined) params.set(name, value);
  }
  const query = params.toString();
  redirect(`/admin/settings/${tab}${query ? `?${query}` : ""}`);
}
