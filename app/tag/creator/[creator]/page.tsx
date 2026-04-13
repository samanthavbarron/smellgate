/**
 * Tag page: perfumes by a given creator (Phase 4.B, issue #67).
 *
 * Route: `/tag/creator/[creator]`. Same exact-match lookup semantics as
 * the by-house tag page.
 */
import { getDb } from "@/lib/db";
import { getPerfumesByCreator } from "@/lib/db/smellgate-queries";
import { TagPage } from "@/components/TagPage";

type Params = Promise<{ creator: string }>;

export default async function CreatorTagPage({
  params,
}: {
  params: Params;
}) {
  const { creator: raw } = await params;
  // Next 16 leaves `params` URL-encoded; decode to match the indexed
  // value. See `app/perfume/[uri]/page.tsx` for the full story.
  const creator = decodeURIComponent(raw);
  const db = getDb();
  const perfumes = await getPerfumesByCreator(db, creator);
  return <TagPage kindLabel="Creator" value={creator} perfumes={perfumes} />;
}
