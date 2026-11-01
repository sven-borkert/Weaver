import {
  redirectToSettings,
  type LegacySearchParams,
} from "../settings/redirect";
export default function LegacyAdminPage({
  searchParams,
}: {
  searchParams: Promise<LegacySearchParams>;
}) {
  return redirectToSettings("remote-instances", searchParams);
}
