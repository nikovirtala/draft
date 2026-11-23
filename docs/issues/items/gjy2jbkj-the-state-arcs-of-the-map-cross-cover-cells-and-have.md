# the state arcs of the map cross, cover cells and have arrowheads of different sizes

## Goal
The arcs between a kind's state cells (Open, In progress, Closed) are drawn over the cells' top edge, cross each other, and have arrowheads of different sizes, one a large triangle over the Closed cell. Arcs should start and end on the cells' top edge without covering a label, stack without crossing (shorter lower, longer higher), and every arrowhead should be the same size, scaled with the stroke.

## Done when
A test of the geometry shows no two arcs' paths intersect for a three-state and a six-state kind and the arrowhead size is constant; screenshots of Issues (three states) and Decisions (six).
