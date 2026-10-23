import { connection } from "next/server";
import { AppPage } from "@/components/AppPage";
import { brandingFromApi } from "@/lib/branding";
import { readOrganizationBranding } from "@/lib/brandingRead";

export default async function Home() {
  // Rendered per request, never at build time: the app wears its organization's
  // branding as it stands now, read with the deployment's key, which a build
  // does not have. A read that fails renders the page unbranded.
  await connection();
  return <AppPage branding={brandingFromApi(await readOrganizationBranding())} />;
}
