# decide the footer's ground: page, as built, or titlebar, as tokens.json says

## Goal
Pick one ground for the footer, then make tokens.json, styles.css and the Frame preview say the same.

## Notes
tokens.json says titlebar is for 'the title bar and the footer'; styles.css draws the footer on page. The Frame preview draws both side by side, labelled A (page, as built) and B (titlebar). Drift D6 in the design spec; split from vr20g4rb, whose D5 part is done.

## Done when
The person has chosen A or B; the unchosen one is gone from the Frame preview, and tokens.json's titlebar usage and the footer's CSS agree.
