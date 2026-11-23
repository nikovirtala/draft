# focus on the panel divider and on an attention item is a fill, not the focus ring

## Goal
Keyboard focus is the 1.5px moved-mark ring and never a fill. The divider and the attention list's buttons show focus as moved-fill, which is the pointer's mark.

## Notes
styles.css:805-807 (`.panel-divider:focus-visible`) and :1145-1147 (`.attention-open:focus-visible`). Keep moved-fill for hover only.

## Done when
Both show the ring when focused by keyboard and moved-fill only under the pointer.
