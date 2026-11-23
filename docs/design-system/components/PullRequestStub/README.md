# PullRequestStub

A live status of a pull request inside the conversation: its reference, its title and its state as chips. Merged is a filled done chip with a check, the same weight and shape as "8/8 checks passed". Open is under way elsewhere; a review requested from you is a wait; a failing check or a conflict is a failure chip; closed without merging is not started's hairline, since nothing more will happen.

The card is `raised` with a `line-strong` hairline; the title is `ink`, the reference `muted` in mono. The dot before the reference repeats the strongest state in its mark colour.

A Kiro session's stub says what Kiro Remote decided about it, from its change feed: a pull request it waits for is a wait chip in `waiting-fill` ("Waiting for nikovirtala/kiro-remote#7"), and why it last woke is a `moved-fill` chip with the word in `moved-strong` ("Woke: a pull request it waited for nikovirtala/kiro-remote#7 merged"). When the feed stopped at something draft can't read, the waits are marked out of date in words.
