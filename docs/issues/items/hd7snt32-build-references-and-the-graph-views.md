# Build references and the graph views

## Goal
Let the user reference any item by address with @-mentions, and show the graph, linear and backlinks views computed from the log.

## Notes
- Items already have addresses `<context>/<conversation>/<item>@<version>`, and `reference.made` stores edges with a kind (structural, explicit, suggested), a relation and a snapshot.
- This slice only makes references to Kiro sessions it finds in text and tool results; user mentions are `explicit`, the agent's and tool results' are `structural`. Revisit that classification when suggested edges arrive.
- Design: "References and the graph".

## Done when
- An @-mention of an item records an explicit edge to its version.
- Graph, linear and backlinks views are rebuilt from the log alone.
- Suggested edges stay suggestions until accepted, and accepting one is a raw event.
