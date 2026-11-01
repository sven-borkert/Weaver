import { redirect } from "next/navigation";

export default function AdminConnectionsRedirect() {
  redirect("/account/connections");
}
