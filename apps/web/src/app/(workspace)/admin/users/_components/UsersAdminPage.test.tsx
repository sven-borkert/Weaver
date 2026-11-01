import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UsersTable } from "./UsersAdminPage";

describe("UsersTable", () => {
  const rows = [
    {
      id: "11111111-1111-1111-1111-111111111111",
      email: "person@test.local",
      name: "Person",
      role: "User" as const,
      active: true,
      banReason: null,
      lastLoginAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      mustChangePassword: false,
    },
  ];

  it("renders a user row with email, role, and status", () => {
    const html = renderToStaticMarkup(<UsersTable users={rows} />);
    expect(html).toContain("person@test.local");
    expect(html).toContain("User");
    expect(html).toContain("Active");
    expect(html).toContain(
      'href="/admin/users/11111111-1111-1111-1111-111111111111"',
    );
  });

  it("marks a deactivated user", () => {
    const html = renderToStaticMarkup(
      <UsersTable
        users={[{ ...rows[0]!, active: false, banReason: "left" }]}
      />,
    );
    expect(html).toContain("Deactivated");
  });
});
