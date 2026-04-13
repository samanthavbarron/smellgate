/**
 * Profile redirect (Phase 4.C, issue #68).
 *
 * Route: `/profile/me` — a simple server-side redirect to either the
 * signed-in user's DID-keyed profile or to the login route. No UI is
 * ever rendered; this component's body will always throw the
 * redirect.
 *
 * Login path: `/#sign-in` — same target `SiteHeader` uses when the
 * visitor is logged out. `/oauth/login` is POST-only (it accepts a
 * handle in the body and returns the authorization URL), so we
 * route unauthenticated visitors to the home-page sign-in form
 * anchor instead.
 */
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export default async function ProfileMePage() {
  const session = await getSession();
  if (!session) {
    redirect("/#sign-in");
  }
  redirect(`/profile/${encodeURIComponent(session.did)}`);
}
