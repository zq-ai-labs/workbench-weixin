import { homedir } from 'node:os'
import { join } from 'node:path'
import { CHANNEL_API_VERSION, type WorkbenchChannels } from './contract.js'
import { createWechatChannel } from './channel.js'
import { WechatConnector } from './reader.js'

export { createWechatChannel } from './channel.js'
export { WechatBridge, WechatConnector } from './reader.js'

export const name = 'workbench-weixin'
/** Needs the task workbench (bkms-workbench); without it this plugin stays inactive. */
export const inject = ['workbenchChannels']
export function apply(ctx: any): void {
  const channels = ctx.workbenchChannels as WorkbenchChannels
  if (channels.apiVersion !== CHANNEL_API_VERSION) ctx.logger?.warn?.('workbench-weixin: channel API %d, workbench %d; upgrade the older one', CHANNEL_API_VERSION, channels.apiVersion)
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  // Decrypted database copies and keys stay in this plugin's own data folder; clearing the cache in settings removes them.
  const channel = createWechatChannel(new WechatConnector(join(home, 'data', 'workbench-weixin', 'cache')))
  // The workbench closes the channel when it is removed (this plugin unloaded, or the workbench stopping).
  ctx.effect(() => channels.register(channel), 'workbench-weixin: WeChat channel')
}
