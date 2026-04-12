import { Kysely, Migration } from "kysely";
import { getDb } from ".";
import { Migrator } from "kysely";

const migrations: Record<string, Migration> = {
  "001": {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable("auth_state")
        .addColumn("key", "text", (col) => col.primaryKey())
        .addColumn("value", "text", (col) => col.notNull())
        .execute();

      await db.schema
        .createTable("auth_session")
        .addColumn("key", "text", (col) => col.primaryKey())
        .addColumn("value", "text", (col) => col.notNull())
        .execute();

      await db.schema
        .createTable("account")
        .addColumn("did", "text", (col) => col.primaryKey())
        .addColumn("handle", "text", (col) => col.notNull())
        .addColumn("active", "integer", (col) => col.notNull().defaultTo(1))
        .execute();

      await db.schema
        .createTable("status")
        .addColumn("uri", "text", (col) => col.primaryKey())
        .addColumn("authorDid", "text", (col) => col.notNull())
        .addColumn("status", "text", (col) => col.notNull())
        .addColumn("createdAt", "text", (col) => col.notNull())
        .addColumn("indexedAt", "text", (col) => col.notNull())
        .addColumn("current", "integer", (col) => col.notNull().defaultTo(0))
        .execute();

      await db.schema
        .createIndex("status_current_idx")
        .on("status")
        .columns(["current", "indexedAt"])
        .execute();
    },
    async down(db: Kysely<unknown>) {
      await db.schema.dropTable("status").execute();
      await db.schema.dropTable("account").execute();
      await db.schema.dropTable("auth_session").execute();
      await db.schema.dropTable("auth_state").execute();
    },
  },
  // Additive: create the com.smellgate.* read-cache tables. Leaves the
  // existing xyz.statusphere.status plumbing alone.
  "002_smellgate_cache": {
    async up(db: Kysely<unknown>) {
      // --- perfume (curator-only) ------------------------------------
      await db.schema
        .createTable("smellgate_perfume")
        .addColumn("uri", "text", (col) => col.primaryKey())
        .addColumn("cid", "text", (col) => col.notNull())
        .addColumn("author_did", "text", (col) => col.notNull())
        .addColumn("indexed_at", "integer", (col) => col.notNull())
        .addColumn("name", "text", (col) => col.notNull())
        .addColumn("house", "text", (col) => col.notNull())
        .addColumn("creator", "text")
        .addColumn("release_year", "integer")
        .addColumn("description", "text")
        .addColumn("external_refs_json", "text")
        .addColumn("created_at", "text", (col) => col.notNull())
        .execute();
      await db.schema
        .createIndex("smellgate_perfume_author_idx")
        .on("smellgate_perfume")
        .columns(["author_did", "indexed_at"])
        .execute();
      await db.schema
        .createIndex("smellgate_perfume_house_idx")
        .on("smellgate_perfume")
        .column("house")
        .execute();
      await db.schema
        .createIndex("smellgate_perfume_creator_idx")
        .on("smellgate_perfume")
        .column("creator")
        .execute();

      await db.schema
        .createTable("smellgate_perfume_note")
        .addColumn("perfume_uri", "text", (col) => col.notNull())
        .addColumn("note", "text", (col) => col.notNull())
        .addPrimaryKeyConstraint("smellgate_perfume_note_pk", [
          "perfume_uri",
          "note",
        ])
        .execute();
      await db.schema
        .createIndex("smellgate_perfume_note_note_idx")
        .on("smellgate_perfume_note")
        .column("note")
        .execute();

      // --- perfumeSubmission ----------------------------------------
      await db.schema
        .createTable("smellgate_perfume_submission")
        .addColumn("uri", "text", (col) => col.primaryKey())
        .addColumn("cid", "text", (col) => col.notNull())
        .addColumn("author_did", "text", (col) => col.notNull())
        .addColumn("indexed_at", "integer", (col) => col.notNull())
        .addColumn("name", "text", (col) => col.notNull())
        .addColumn("house", "text", (col) => col.notNull())
        .addColumn("creator", "text")
        .addColumn("release_year", "integer")
        .addColumn("description", "text")
        .addColumn("rationale", "text")
        .addColumn("created_at", "text", (col) => col.notNull())
        .execute();
      await db.schema
        .createIndex("smellgate_perfume_submission_author_idx")
        .on("smellgate_perfume_submission")
        .columns(["author_did", "indexed_at"])
        .execute();

      await db.schema
        .createTable("smellgate_perfume_submission_note")
        .addColumn("submission_uri", "text", (col) => col.notNull())
        .addColumn("note", "text", (col) => col.notNull())
        .addPrimaryKeyConstraint("smellgate_perfume_submission_note_pk", [
          "submission_uri",
          "note",
        ])
        .execute();
      await db.schema
        .createIndex("smellgate_perfume_submission_note_note_idx")
        .on("smellgate_perfume_submission_note")
        .column("note")
        .execute();

      // --- perfumeSubmissionResolution (curator-only) ---------------
      await db.schema
        .createTable("smellgate_perfume_submission_resolution")
        .addColumn("uri", "text", (col) => col.primaryKey())
        .addColumn("cid", "text", (col) => col.notNull())
        .addColumn("author_did", "text", (col) => col.notNull())
        .addColumn("indexed_at", "integer", (col) => col.notNull())
        .addColumn("submission_uri", "text", (col) => col.notNull())
        .addColumn("submission_cid", "text", (col) => col.notNull())
        .addColumn("decision", "text", (col) => col.notNull())
        .addColumn("perfume_uri", "text")
        .addColumn("perfume_cid", "text")
        .addColumn("note", "text")
        .addColumn("created_at", "text", (col) => col.notNull())
        .execute();
      await db.schema
        .createIndex("smellgate_perfume_submission_resolution_author_idx")
        .on("smellgate_perfume_submission_resolution")
        .columns(["author_did", "indexed_at"])
        .execute();
      await db.schema
        .createIndex("smellgate_perfume_submission_resolution_submission_idx")
        .on("smellgate_perfume_submission_resolution")
        .column("submission_uri")
        .execute();

      // --- shelfItem ------------------------------------------------
      await db.schema
        .createTable("smellgate_shelf_item")
        .addColumn("uri", "text", (col) => col.primaryKey())
        .addColumn("cid", "text", (col) => col.notNull())
        .addColumn("author_did", "text", (col) => col.notNull())
        .addColumn("indexed_at", "integer", (col) => col.notNull())
        .addColumn("perfume_uri", "text", (col) => col.notNull())
        .addColumn("perfume_cid", "text", (col) => col.notNull())
        .addColumn("acquired_at", "text")
        .addColumn("bottle_size_ml", "integer")
        .addColumn("is_decant", "integer")
        .addColumn("created_at", "text", (col) => col.notNull())
        .execute();
      await db.schema
        .createIndex("smellgate_shelf_item_author_idx")
        .on("smellgate_shelf_item")
        .columns(["author_did", "indexed_at"])
        .execute();
      await db.schema
        .createIndex("smellgate_shelf_item_perfume_idx")
        .on("smellgate_shelf_item")
        .column("perfume_uri")
        .execute();

      // --- review ---------------------------------------------------
      await db.schema
        .createTable("smellgate_review")
        .addColumn("uri", "text", (col) => col.primaryKey())
        .addColumn("cid", "text", (col) => col.notNull())
        .addColumn("author_did", "text", (col) => col.notNull())
        .addColumn("indexed_at", "integer", (col) => col.notNull())
        .addColumn("perfume_uri", "text", (col) => col.notNull())
        .addColumn("perfume_cid", "text", (col) => col.notNull())
        .addColumn("rating", "integer", (col) => col.notNull())
        .addColumn("sillage", "integer", (col) => col.notNull())
        .addColumn("longevity", "integer", (col) => col.notNull())
        .addColumn("body", "text", (col) => col.notNull())
        .addColumn("created_at", "text", (col) => col.notNull())
        .execute();
      await db.schema
        .createIndex("smellgate_review_author_idx")
        .on("smellgate_review")
        .columns(["author_did", "indexed_at"])
        .execute();
      await db.schema
        .createIndex("smellgate_review_perfume_idx")
        .on("smellgate_review")
        .column("perfume_uri")
        .execute();

      // --- description ---------------------------------------------
      await db.schema
        .createTable("smellgate_description")
        .addColumn("uri", "text", (col) => col.primaryKey())
        .addColumn("cid", "text", (col) => col.notNull())
        .addColumn("author_did", "text", (col) => col.notNull())
        .addColumn("indexed_at", "integer", (col) => col.notNull())
        .addColumn("perfume_uri", "text", (col) => col.notNull())
        .addColumn("perfume_cid", "text", (col) => col.notNull())
        .addColumn("body", "text", (col) => col.notNull())
        .addColumn("created_at", "text", (col) => col.notNull())
        .execute();
      await db.schema
        .createIndex("smellgate_description_author_idx")
        .on("smellgate_description")
        .columns(["author_did", "indexed_at"])
        .execute();
      await db.schema
        .createIndex("smellgate_description_perfume_idx")
        .on("smellgate_description")
        .column("perfume_uri")
        .execute();

      // --- vote -----------------------------------------------------
      await db.schema
        .createTable("smellgate_vote")
        .addColumn("uri", "text", (col) => col.primaryKey())
        .addColumn("cid", "text", (col) => col.notNull())
        .addColumn("author_did", "text", (col) => col.notNull())
        .addColumn("indexed_at", "integer", (col) => col.notNull())
        .addColumn("subject_uri", "text", (col) => col.notNull())
        .addColumn("subject_cid", "text", (col) => col.notNull())
        .addColumn("direction", "text", (col) => col.notNull())
        .addColumn("created_at", "text", (col) => col.notNull())
        .execute();
      await db.schema
        .createIndex("smellgate_vote_author_idx")
        .on("smellgate_vote")
        .columns(["author_did", "indexed_at"])
        .execute();
      await db.schema
        .createIndex("smellgate_vote_subject_idx")
        .on("smellgate_vote")
        .column("subject_uri")
        .execute();

      // --- comment --------------------------------------------------
      await db.schema
        .createTable("smellgate_comment")
        .addColumn("uri", "text", (col) => col.primaryKey())
        .addColumn("cid", "text", (col) => col.notNull())
        .addColumn("author_did", "text", (col) => col.notNull())
        .addColumn("indexed_at", "integer", (col) => col.notNull())
        .addColumn("subject_uri", "text", (col) => col.notNull())
        .addColumn("subject_cid", "text", (col) => col.notNull())
        .addColumn("body", "text", (col) => col.notNull())
        .addColumn("created_at", "text", (col) => col.notNull())
        .execute();
      await db.schema
        .createIndex("smellgate_comment_author_idx")
        .on("smellgate_comment")
        .columns(["author_did", "indexed_at"])
        .execute();
      await db.schema
        .createIndex("smellgate_comment_subject_idx")
        .on("smellgate_comment")
        .column("subject_uri")
        .execute();
    },
    async down(db: Kysely<unknown>) {
      await db.schema.dropTable("smellgate_comment").execute();
      await db.schema.dropTable("smellgate_vote").execute();
      await db.schema.dropTable("smellgate_description").execute();
      await db.schema.dropTable("smellgate_review").execute();
      await db.schema.dropTable("smellgate_shelf_item").execute();
      await db.schema
        .dropTable("smellgate_perfume_submission_resolution")
        .execute();
      await db.schema.dropTable("smellgate_perfume_submission_note").execute();
      await db.schema.dropTable("smellgate_perfume_submission").execute();
      await db.schema.dropTable("smellgate_perfume_note").execute();
      await db.schema.dropTable("smellgate_perfume").execute();
    },
  },
};

export function getMigrator() {
  const db = getDb();
  return new Migrator({
    db,
    provider: {
      getMigrations: async () => migrations,
    },
  });
}
