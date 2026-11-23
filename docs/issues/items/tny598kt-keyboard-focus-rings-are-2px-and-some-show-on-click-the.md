# keyboard focus rings are 2px and some show on click; the spec's ring is 1.5px through :focus-visible

## Goal
Every focus ring is a 1.5px moved-mark outline drawn through :focus-visible only, as the one for blocks already is.

## Notes
styles.css:443 (button, textarea), :1475 (`.map-range label:focus-within`, shows after a click), :1588 (`.map-cell`, `.map-item`), :1774 (`.graph-heading`), :1789 (`.graph-stage`), :1945 (`.graph-node`) draw 2px; only :945 draws 1.5px. One shared rule would remove the drift.

## Done when
One ring rule, 1.5px moved-mark, :focus-visible; a click on a map range option shows no ring; a test lists every outline in styles.css and finds only that one.
