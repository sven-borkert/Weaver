export function parseDatabaseUrl(value) {
  const url = new URL(value);
  const name = decodeURIComponent(url.pathname.slice(1));
  const password = decodeURIComponent(url.password);
  const user = decodeURIComponent(url.username);
  if (!/^postgres(?:ql)?:$/.test(url.protocol) || name !== "weaver")
    throw new Error("DATABASE_URL must target the weaver database");
  if (
    !password ||
    password === "password" ||
    password.startsWith("REPLACE_WITH_")
  )
    throw new Error("Replace the example database password in .env");
  if (/[\r\n\0]/.test(password + user))
    throw new Error("Invalid database credentials");
  return { name, password, user, port: url.port || "5432" };
}
