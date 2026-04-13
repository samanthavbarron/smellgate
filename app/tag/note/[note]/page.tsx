/**
 * Tag page: perfumes with a given note (Phase 4.B, issue #67).
 *
 * Route: `/tag/note/[note]` where `[note]` is an `encodeURIComponent`'d
 * lowercase note string. Next.js 16 leaves the segment URL-encoded in
 * `params`, so we decode manually — same reasoning as the perfume
 * detail page.
 */
import { getDb } from "@/lib/db";
import { getPerfumesByNote } from "@/lib/db/smellgate-queries";
import { TagPage } from "@/components/TagPage";

type Params = Promise<{ note: string }>;

export default async function NoteTagPage({ params }: { params: Params }) {
  const { note: raw } = await params;
  const note = decodeURIComponent(raw);
  const db = getDb();
  const perfumes = await getPerfumesByNote(db, note);
  return <TagPage kindLabel="Note" value={note} perfumes={perfumes} />;
}
