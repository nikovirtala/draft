# Add the built-in browser

## Goal
Open external links as web page blocks inside draft, one browser per thread, with resolvers taking precedence over pages.

## Notes
- Today `setWindowOpenHandler` sends http(s) links to the system browser and the window never navigates.
- Page text is untrusted input; sign-ins are kept per context; visits are raw events only if the context allows it.
- Design: "Built-in browser".

## Done when
- A link opens as a web page block that follows the placement rules.
- A reference to a page keeps a snapshot (URL, title, time, content hash).
- Cookies are separate per context.
