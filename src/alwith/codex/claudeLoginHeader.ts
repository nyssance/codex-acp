/**
 * A gateway that runs on the application's Claude login carries the login file in this header,
 * percent-encoded, next to `X-Alwith-Anthropic-Auth-Mode: oauth`. It reaches only the local proxy.
 */
export const CLAUDE_LOGIN_HEADER = "x-alwith-anthropic-login";
