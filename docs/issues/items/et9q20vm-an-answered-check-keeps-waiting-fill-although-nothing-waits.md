# an answered check keeps waiting-fill although nothing waits on the person

## Goal
Drop the waiting-fill of a check once it is passed or failed and nothing is offered, as a settled interrupt does.

## Notes
Screenshots k03 and k04: the failed check and the passed check are still waiting-fill. Spec A10 allows the fill only when a block asks the person for something, and says a closed interrupt drops it (.interrupt.closed); CheckBlock never adds that class. A passed check that hosts an acceptance request has the request, itself filled, as the one thing that asks. The Check preview draws the settled states without a fill.

## Done when
An answered check has no state fill; the request it hosts keeps its own; k03 and k04 match the Check preview.
