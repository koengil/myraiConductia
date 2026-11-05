/** One RFC 5322 msg-id in angle brackets, no whitespace and no nested brackets (#339 reply threading). */
export const MESSAGE_ID_RX = /^<[^<>\s]{1,250}>$/;

/** The most thread participants a reply token carries; a wider thread's reply to anyone past them goes out unthreaded. */
export const MAX_REPLY_PARTICIPANTS = 200;
