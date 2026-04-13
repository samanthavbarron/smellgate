/**
 * Tag page: perfumes by a given house (Phase 4.B, issue #67).
 *
 * Route: `/tag/house/[house]`. Value is the exact house name as
 * published on the canonical perfume record — `getPerfumesByHouse` does
 * an exact-match lookup, not a case-insensitive one, so URLs must use
 * the indexed casing.
 */
import { getDb } from "@/lib/db";
import { getPerfumesByHouse } from "@/lib/db/smellgate-queries";
import { TagPage } from "@/components/TagPage";

type Params = Promise<{ house: string }>;

export default async function HouseTagPage({ params }: { params: Params }) {
  const { house: raw } = await params;
  // Next 16 leaves `params` URL-encoded; decode to match the indexed
  // value. See `app/perfume/[uri]/page.tsx` for the full story.
  const house = decodeURIComponent(raw);
  const db = getDb();
  const perfumes = await getPerfumesByHouse(db, house);
  return <TagPage kindLabel="House" value={house} perfumes={perfumes} />;
}
