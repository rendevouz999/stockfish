# External Memory import schema v1

This is an import adapter, **not a live Memory integration**. Keep real exports private. The example below is a shape template, not evidence and not preloaded telemetry. Replace placeholder IDs/timestamps with authentic source records and actual arena game/decision IDs. Do not submit fabricated events to fill a chart.

```json
{
  "schema_version": 1,
  "events": [
    {
      "event_id": "original-source-event-id",
      "game_id": "actual-arena-game-id",
      "decision_id": "actual-arena-decision-id",
      "kind": "retrieval",
      "occurred_at": "2026-10-11T12:00:00.000Z",
      "retrieval_ids": ["actual-retrieved-memory-id"],
      "source": {
        "system": "Agent Core Memory",
        "export_id": "source-export-or-trace-id"
      },
      "details": "Optional original source context. No secrets."
    }
  ]
}
```

## Fields

- `schema_version`: exactly `1`; batch limit 1,000 events and HTTP body limit 1 MiB
- `event_id`: source event identity, nonempty string up to 128 characters
- `game_id`: a game already present in this journal
- `decision_id`: an existing `position_ready` decision in that same game; required for retrieval and applied lessons, optional for lesson creation
- `kind`: `retrieval`, `lesson_created`, or `lesson_applied`
- `occurred_at`: source-reported ISO timestamp with explicit timezone; source clocks are not assumed synchronized
- `source.system`, `source.export_id`: nonempty strings up to 128 characters
- `retrieval_ids`: required, nonempty array for retrieval; optional otherwise; at most 1,000 nonempty ID strings, each up to 128 characters
- `lesson`: required for `lesson_created` / `lesson_applied`; optional on retrieval but fully validated if present
- `details`: optional text, at most 4,000 characters; use references rather than sensitive memory contents when possible

Lesson shape:

```json
{
  "id": "stable-source-lesson-id",
  "version": "v2",
  "provenance": "source trace or document reference explaining origin and revision"
}
```

Lesson ID is a nonempty string (128 characters max), version is an explicit nonempty string (128 max) or a nonnegative safe integer, and provenance is a nonempty string (2,000 max). Objects, booleans, fractional numbers and implicit version conversions are rejected. Control characters are rejected in identifiers/provenance.

Identity for deduplication is `(source.system, source.export_id, event_id)`. Reimporting identical normalized content returns a duplicate count. Reusing that identity with different content rejects the batch. The whole batch is validated before records are appended. An actual storage failure can still stop a batch after durable individual records; retrying the unchanged batch safely deduplicates already-imported entries.

## Provenance status

The server appends `memory_imported` with:

- `verification: "imported_unverified"`
- `receipt_status: "local_import_recorded"`
- `timestamp_utc`: when this server recorded the import
- `memory.occurred_at`: when the external source claims the event happened
- the normalized original fields under `memory`

The HTTP success receipt and local fsync establish **receipt**, not authenticity. Input fields named `verified` or `verification` are rejected. This version has no trusted connector, cryptographic source verification or verified Memory status. It cannot confirm retrieval relevance, internal reasoning, learning, causation or production Memory writes from imported claims.

A future separately authorized live bridge would need a concrete trust model, source evidence and real receipt verification before any stronger label is introduced. No credentials or changes to Agent Core production are part of this arena.
