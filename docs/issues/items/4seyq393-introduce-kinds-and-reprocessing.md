# Introduce kinds and reprocessing

## Goal
Add the first kind (versioned schema, extractor, renderer) and replay the raw log through it.

## Notes
- Design: "Knowledge pipeline". Raw events are stored as received with a schema version, unknown events are kept, and every view is rebuildable from the log (property-tested), which is what reprocessing needs.
- IDs must survive reprocessing: prototype the identity spike first.

## Done when
- A kind can be registered and replayed over an existing log.
- Its interpretations record their raw source, kind version and model.
