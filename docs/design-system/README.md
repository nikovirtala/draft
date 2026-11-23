# draft

draft's palette: pastel states on cream.

`tokens.json` is the source of truth for draft's colours, type, spacing, radii and line widths: the app's palette is generated from it or checked against it, never typed again. The live, browsable version with its component previews is the [draft design system](https://claude.ai/artifact/WNcDWLGuLeanwAA9H3Xm8M); `components/*/preview.html` are those previews, which read the tokens as CSS custom properties.

## Principles

- **A colour means one thing, everywhere, always.** Purple is what moved or the agent's activity, green what is done, blue what is under way elsewhere, amber what waits on you. A meaning never borrows another's colour, and a colour never changes its meaning along the way.
- **Pastel fills carry the state.** The fill is the colour people see. Strong colour appears only in small marks (dots, arcs, arrows, a check) and in words. No strong colour fills an area or draws a thick ring.
- **Three jobs per meaning.** A `*-fill` for areas, a `*-mark` for lines and marks, a `*-word` for text. A test in draft keeps each token in its job.
- **Never colour alone.** The word always names the state; a failure is told by its cross and dashed outline, an open loop by its dashed ring. That also serves people who see colour differently.
- **Hairlines.** Every line around a box is a hairline, half a pixel (one device pixel on a Retina screen), in sand. Boxes are told apart by their fill, not by their frame.
- **Readable words.** Every text colour is at least 4.5:1 on the surface it is drawn on. Marks are not text and have no such floor.

## Meanings

| Meaning | Fill | Mark | Word | Word on fill |
| --- | --- | --- | --- | --- |
| Moved, the agent's activity | #ebe2fd soft, #d7c5fb selected | #9e6ef7 | #b18bf8 pastel; #8c42f6 in chips and badges | 4.0:1 in a chip |
| Done, settled | #d7f2e4 | #009456 | #007a47 | 4.6:1 |
| Under way elsewhere | #dcefff | #0a7fd1 | #0069b0 | 4.9:1 |
| Waits on you (and failures) | #fbecc9 | #b87700 | #8a5a00 | 5.1:1 |
| Not started | none | #b9c4c4 hairline | muted #5d6b6d | 5.2:1 on page |
| Open loop | none | #929ea0 dashed | muted #5d6b6d | 5.2:1 on page |

Purple follows the Wisteria Lily theme: a soft fill for what moved or is under the pointer, a stronger fill for what is selected with ink words on it, pastel purple words for what changed, and one strong purple only for a small badge or a chip's word. Two of those pairs are below 4.5:1 on purpose (pastel words at 2.5:1, a chip's word at 4.0:1); they are used at 12.5 px and up, weight 500, and never as the only sign. The green, blue and amber fills and marks are the delivery board's; their words are darkened in the same hue just far enough for 4.5:1.

## Ground and words

Cream page (#fef8ec), a darker surface for panels (#f9f1e1), lighter raised cards (#fffdf7), sand hairlines. Titles, names and links in teal ink (#005661); body text in a dark slate (#44585a); secondary text in slate (#5d6b6d).

## Components

The previews show each part of draft that carries a state: the state chips (with the board's chips beside draft's for comparison), pull request stubs, acceptance evidence, a failure notice and the working indicator, the map's switches, selection and change the Wisteria Lily way, and the map's graph.
