import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`REDIRECT:${href}`);
  },
}));
vi.mock("../../ai/_components/AiAdminPage", () => ({
  AiAdminPage: () => null,
}));
vi.mock("../../remote-instances/_components/RemoteInstancesScreen", () => ({
  RemoteInstancesScreen: () => null,
}));
import AiPage from "../../ai/page";
import RemotePage from "../../remote-instances/page";
import SettingsPage from "../page";
describe("legacy administration redirects", () => {
  it.each([
    [AiPage, "ai"],
    [RemotePage, "remote-instances"],
  ] as const)(
    "preserves repeated and encoded query values for %s",
    async (Page, tab) => {
      await expect(
        Promise.resolve().then(() =>
          Page({
            searchParams: Promise.resolve({
              model: ["a", "b"],
              search: "hello world",
            }),
          }),
        ),
      ).rejects.toThrow(
        `REDIRECT:/admin/settings/${tab}?model=a&model=b&search=hello+world`,
      );
    },
  );
  it("opens AI by default", () => {
    expect(() => SettingsPage()).toThrow("REDIRECT:/admin/settings/ai");
  });
});
