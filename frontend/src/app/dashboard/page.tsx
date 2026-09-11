import { redirect } from "next/navigation";

/** Phase 3 canonical route — the full V2 dashboard lives at `/`. */
export default function DashboardPage() {
  redirect("/");
}
