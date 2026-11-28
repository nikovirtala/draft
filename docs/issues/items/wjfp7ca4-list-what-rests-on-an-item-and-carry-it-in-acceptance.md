# List what rests on an item, and carry it in acceptance requests

## Goal
Any item answers what depends on it, as a list by distance, and every acceptance request carries that list as evidence.

## Notes
- Design: docs/model.md, "References and the graph" and "Acceptance". Roadmap slice 11. A traversal of the edges projection (effects outward), not a new store.
- An item that much rests on is read more often by its resolver.

## Done when
- For a decision in a fixture, the list shows what references it directly, then each hop further, with kind and state, in a fixed order.
- An ADR's and a pull request's acceptance request show the list as an evidence row.
- A resolver's interval for an item shortens as the count resting on it grows, within its bounds; a test covers it.
