import { withBasePath } from "~/lib/basePath";

/** Sign-in and consent stay light in both themes: the artwork has no dark variant. */
export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="theme-light bg-canvas text-text relative min-h-screen">
      <div
        aria-hidden="true"
        className="absolute inset-0 hidden bg-cover bg-center sm:block"
        style={{
          backgroundImage: `url(${withBasePath("/login-background.webp")})`,
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
