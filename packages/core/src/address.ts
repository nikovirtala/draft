/**
 * Item addresses: `<context>/<conversation>/<item>@<version>`.
 *
 * Every address names its context from day one, so linking contexts later needs no migration.
 * Shorter forms address the containers themselves: `<context>@<version>` is a context and
 * `<context>/<conversation>@<version>` a conversation, which is an item like any other (a thread,
 * later, is a conversation with a parent message). The version is optional when parsing, where it
 * means "the latest version", and required on every event.
 */

/** One address segment: lowercase letters, digits and inner hyphens, at most 64 characters. */
const SEGMENT = "[0-9a-z](?:[0-9a-z-]{0,62}[0-9a-z])?";
const ADDRESS_RE = new RegExp(
  `^(${SEGMENT})(?:/(${SEGMENT})(?:/(${SEGMENT}))?)?(?:@([1-9][0-9]{0,8}))?$`,
);
const SEGMENT_RE = new RegExp(`^${SEGMENT}$`);

export interface Address {
  readonly context: string;
  readonly conversation: string | null;
  readonly item: string | null;
  /** `null` means "the latest version". */
  readonly version: number | null;
}

export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressError";
  }
}

export function isSegment(s: string): boolean {
  return SEGMENT_RE.test(s);
}

/** Parses an address; throws `AddressError` naming what is wrong. */
export function parseAddress(input: string): Address {
  const m = ADDRESS_RE.exec(input);
  if (m === null) {
    throw new AddressError(
      `not an address: ${JSON.stringify(input)} (expected <context>/<conversation>/<item>@<version>)`,
    );
  }
  return {
    context: m[1] as string,
    conversation: m[2] ?? null,
    item: m[3] ?? null,
    version: m[4] === undefined ? null : Number(m[4]),
  };
}

export function tryParseAddress(input: string): Address | null {
  try {
    return parseAddress(input);
  } catch {
    return null;
  }
}

export function formatAddress(a: Address): string {
  for (const [name, v] of [
    ["context", a.context],
    ["conversation", a.conversation],
    ["item", a.item],
  ] as const) {
    if (v !== null && !isSegment(v))
      throw new AddressError(`invalid ${name} segment ${JSON.stringify(v)}`);
  }
  if (a.item !== null && a.conversation === null) {
    throw new AddressError("an item address needs a conversation");
  }
  if (a.version !== null && (!Number.isInteger(a.version) || a.version < 1)) {
    throw new AddressError(`invalid version ${a.version}`);
  }
  let s = a.context;
  if (a.conversation !== null) s += `/${a.conversation}`;
  if (a.item !== null) s += `/${a.item}`;
  if (a.version !== null) s += `@${a.version}`;
  return s;
}

/** `<context>/<conversation>`: the key every event uses to name its conversation. */
export function conversationKey(context: string, conversation: string): string {
  return formatAddress({ context, conversation, item: null, version: null });
}

export function itemAddress(conversation: string, item: string, version = 1): string {
  const c = parseAddress(conversation);
  if (c.conversation === null) throw new AddressError(`not a conversation: ${conversation}`);
  return formatAddress({ ...c, item, version });
}

/** The address without its version: the stable identity of an item across versions. */
export function unversioned(address: string): string {
  return formatAddress({ ...parseAddress(address), version: null });
}
