/**
 * Error with an HTTP status and a code for the page. The workbench reads `status` and `code` from any error a channel
 * throws (contract.ts, `ChannelError`), so this plugin keeps its own class.
 */
export class WechatError extends Error {
  constructor(message: string, readonly code = 'invalid', readonly status = 400) { super(message) }
}
