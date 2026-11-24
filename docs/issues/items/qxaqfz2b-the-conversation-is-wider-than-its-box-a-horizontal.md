# the conversation is wider than its box: a horizontal scrollbar shows under it

## Goal
Only a code block, a table and a map row scroll sideways (spec, The frame, Scrolling). The conversation itself never gets a horizontal scrollbar: whatever is too wide wraps or truncates inside its box.

## Notes
Seen in the screenshots of PR 57, a03 (live stubs and a failed check) and a04 (what needs you: count and order): a horizontal scrollbar under the conversation, in the main column beside the open thread. Both show an expanded stub whose details end in a long link (`https://github.com/nikovirtala/draft/tree/HEAD/docs/issue…`, `http://127.0.0.1:…/a/01kahx7z1m2n3p4q5r6s7t9v9w`) running to the edge of the box, so the likely cause is the details list (`.stub-details dd`, a grid cell with no `min-width: 0` and no wrapping) widening the column. Not confirmed. The window check does not see it: the document does not scroll, only the conversation does.

## Done when
In a03 and a04 the conversation has no horizontal scrollbar and the long link wraps or truncates inside the stub; the window check or a second check fails when a conversation or a block body scrolls sideways outside a code block, a table or a map row.
