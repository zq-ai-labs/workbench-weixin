import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNEL_API_VERSION } from '../lib/contract.js'
import { createWechatChannel } from '../lib/channel.js'
import { WechatBridge, WechatConnector, appendPending, chatAllowed, segmentDue, segmentVerdict, transcript } from '../lib/reader.js'
import * as plugin from '../lib/index.js'

/**
 * The WeChat channel on its own, the way the workbench uses it: settings are validated and saved, `poll()` reads, and
 * the result's `commit()` is applied to the saved state (in the workbench, inside one transaction). The workbench's own
 * behaviour with a channel — queueing, triage, the copied reply — is tested in bkms-workbench.
 */
const here = fileURLToPath(new URL('.', import.meta.url))
const minutesAgo = m => new Date(Date.now() - m * 60000).toISOString()
const settings = (patch = {}) => ({ enabled: true, people: { mode: 'allow', list: ['wxid_li'] }, groups: { mode: 'allow', list: [], scope: 'mention' }, ...patch })

function fakeWechat() {
  const chats = [
    { id: 'wxid_li', name: '李明', kind: 'person' },
    { id: 'wxid_mom', name: '妈妈', kind: 'person' },
    { id: '111@chatroom', name: '华东交付群', kind: 'group' },
    { id: '222@chatroom', name: '家人群', kind: 'group' },
  ]
  const messages = { wxid_li: [{ seq: 5, at: minutesAgo(60), sender: 'wxid_li', senderName: '李明', self: false, type: '文本', text: '历史消息' }], wxid_mom: [], '111@chatroom': [], '222@chatroom': [] }
  const polled = [], historyCalls = [], chatCalls = []
  let chatGate
  const service = {
    async status() { return { ready: true, wxid: 'wxid_me', name: '赵晓强', library: 'test' } },
    async chats() { chatCalls.push(Date.now()); if (chatGate) await chatGate; return [...chats] },
    async search(q) { return chats.filter(chat => chat.name.includes(q)) },
    async latest(ids) { return Object.fromEntries(ids.map(id => [id, Math.max(0, ...(messages[id] || []).map(m => m.seq))])) },
    async poll(marks) { polled.push(Object.keys(marks)); return Object.fromEntries(Object.entries(marks).map(([id, seq]) => [id, (messages[id] || []).filter(m => m.seq > seq)])) },
    async history(chat, offset, limit) { historyCalls.push(chat); return { messages: (messages[chat] || []).slice(-limit), more: false } },
  }
  let seq = 100
  const say = (chat, text, extra = {}) => { chats.find(c => c.id === chat).lastAt = new Date(Date.now() + seq).toISOString(); messages[chat].push({ seq: ++seq, at: extra.at ?? minutesAgo(10), sender: extra.self ? 'wxid_me' : extra.sender ?? chat, senderName: extra.self ? '赵晓强' : extra.senderName ?? chats.find(c => c.id === chat).name, self: !!extra.self, type: '文本', text, ...(extra.mentionsMe ? { mentionsMe: true } : {}) }) }
  return { service, say, polled, historyCalls, chatCalls, messages, chats, gate(promise) { chatGate = promise } }
}

/** The channel with a fake bridge, plus the part of the workbench that saves settings and applies polls. */
function fixture(t) {
  const fake = fakeWechat(), logs = [], items = []
  let cleared = 0, saved, state = { cursors: {}, entries: {} }
  const channel = createWechatChannel({ service: s => s?.enabled ? fake.service : undefined, async clear() { cleared++ } })
  t.after(() => channel.close())
  return {
    fake, channel, items, logs,
    get state() { return state },
    get cleared() { return cleared },
    /** Saving settings in the workbench: validate, store, then tell the channel. */
    configure(value) { saved = channel.settings.validate(value); channel.settings.changed() },
    async poll() {
      const result = await channel.poll(saved, state, new AbortController().signal)
      if (!result) return 0
      const applied = result.commit(structuredClone(state), Date.now())
      state = applied.state; items.push(...applied.items); logs.push(...applied.logs)
      return applied.items.length
    },
    action(name, body = {}, signal = new AbortController().signal) { return channel.actions[name](body, { settings: saved, signal, log: async message => { logs.push(message) } }) },
  }
}

test('the plugin registers the channel with the workbench service and removes it on unload', () => {
  const registered = [], effects = []
  const ctx = { workbenchChannels: { apiVersion: CHANNEL_API_VERSION, register(channel) { registered.push(channel); return () => registered.splice(registered.indexOf(channel), 1) } }, effect(fn) { effects.push(fn()) } }
  assert.deepEqual(plugin.inject, ['workbenchChannels'])
  plugin.apply(ctx)
  assert.equal(registered.length, 1)
  const [channel] = registered
  assert.equal(channel.kind, 'wechat'); assert.equal(channel.apiVersion, CHANNEL_API_VERSION)
  assert.deepEqual(channel.capabilities, { reply: 'copy', archive: false })
  effects[0]()
  assert.equal(registered.length, 0)
  channel.close()
})

test('every message the channel shows on the page has English', () => {
  const english = JSON.parse(readFileSync(new URL('../system-en.json', import.meta.url), 'utf8'))
  const channel = createWechatChannel({ service: () => undefined })
  assert.deepEqual(channel.systemEnglish, english)
  const pattern = key => new RegExp('^' + key.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\\{\d+\\\}|\{\d+\}/g, '.+') + '$')
  const known = text => Object.hasOwn(english, text) || Object.keys(english).some(key => key.includes('{') && pattern(key).test(text))
  for (const text of [channel.text.readonly, channel.text.notClassified, channel.text.replyNotEditable, channel.text.replyReady, channel.text.handled, channel.text.handledLog, channel.text.created(3)]) assert.ok(known(text), text)
  for (const [key, value] of Object.entries(english)) {
    assert.doesNotMatch(value, /[一-鿿]/, key)
    assert.deepEqual((value.match(/\{\d+\}/g) || []).sort(), (key.match(/\{\d+\}/g) || []).sort(), key)
  }
  channel.close()
})

test('policy helpers: lists, segment timing and verdicts', () => {
  assert.equal(chatAllowed(settings(), 'wxid_li'), true)
  assert.equal(chatAllowed(settings(), 'wxid_mom'), false)
  assert.equal(chatAllowed(settings({ people: { mode: 'block', list: ['wxid_mom'] } }), 'wxid_x'), true)
  assert.equal(chatAllowed(settings({ people: { mode: 'block', list: ['wxid_mom'] } }), 'wxid_mom'), false)
  for (const id of ['gh_news', 'filehelper', '@placeholder_foldgroup']) assert.equal(chatAllowed(settings({ people: { mode: 'block', list: [] } }), id), false, id)
  assert.equal(chatAllowed({ ...settings(), enabled: false }, 'wxid_li'), false)
  const m = (seq, at, extra = {}) => ({ seq, at, sender: 'a', senderName: 'A', self: false, type: '文本', text: 't' + seq, ...extra })
  let p = appendPending(undefined, '群', true, [m(2, minutesAgo(1)), m(1, minutesAgo(2))], new Date().toISOString())
  p = appendPending(p, '群', true, [m(2, minutesAgo(1))], new Date().toISOString())
  assert.deepEqual(p.messages.map(x => x.seq), [1, 2], 'sorted and de-duplicated')
  assert.equal(segmentDue(p, Date.now(), 3), false)
  assert.equal(segmentDue(p, Date.now() + 3 * 60000, 3), true)
  assert.equal(segmentVerdict(p, 'mention'), 'not-mentioned')
  assert.equal(segmentVerdict(p, 'all'), 'task')
  assert.equal(segmentVerdict({ ...p, messages: [...p.messages, m(3, minutesAgo(0), { mentionsMe: true })] }, 'mention'), 'task')
  assert.equal(segmentVerdict({ ...p, messages: [...p.messages, m(4, minutesAgo(0), { self: true })] }, 'all'), 'answered')
  assert.equal(segmentVerdict({ ...p, messages: [m(5, minutesAgo(0), { self: true })] }, 'all'), 'no-others')
  assert.match(transcript([m(1, '2026-10-18T01:02:00Z'), m(2, '2026-10-18T01:03:00Z', { self: true, quote: { sender: 'A', text: '原话' } })]), /我：t2（引用 A：原话）/)
})

test('only allowed conversations are read; history outside the lists is refused', async t => {
  const f = fixture(t)
  f.configure(settings())
  await f.poll()
  assert.deepEqual(Object.keys(f.state.cursors), ['wxid_li'], 'baseline only for the allowed chat')
  f.fake.say('wxid_mom', '记得穿外套'); f.fake.say('wxid_li', '报价单能今天发吗？')
  await f.poll()
  assert.ok(f.fake.polled.every(ids => ids.every(id => id === 'wxid_li')), 'blocked chats are never polled')
  await assert.rejects(f.action('wechatHistory', { chat: 'wxid_mom' }), error => error.status === 403 && /不在允许读取/.test(error.message))
  await assert.rejects(f.action('wechatHistory', { chat: 'gh_news' }), /不在允许读取/)
  assert.equal((await f.action('wechatHistory', { chat: 'wxid_li' })).messages.at(-1).text, '报价单能今天发吗？')
  assert.deepEqual(f.fake.historyCalls, ['wxid_li'])
  // Block mode reads everyone except the blocked people; official accounts never.
  f.configure(settings({ people: { mode: 'block', list: ['wxid_mom'] } }))
  await f.poll()
  assert.deepEqual(Object.keys(f.state.cursors).sort(), ['wxid_li'], 'groups stay on their own (empty) allow list')
  await assert.rejects(f.action('wechatHistory', { chat: 'wxid_mom' }), /不在允许读取/)
})

test('history before enabling is not processed; a quiet segment becomes one item', async t => {
  const f = fixture(t)
  f.configure(settings())
  assert.equal(await f.poll(), 0, 'baseline only')
  assert.match(f.logs[0], /微信会话「李明」已建立基线/)
  f.fake.say('wxid_li', '赵经理，报价单能今天发吗？')
  f.fake.say('wxid_li', '我们下午要内部过一下', { at: minutesAgo(9) })
  assert.equal(await f.poll(), 1)
  const [item] = f.items
  assert.equal(item.scope, 'wxid_li'); assert.equal(item.position, 102); assert.equal(item.subject, '李明')
  assert.equal(item.title, '李明：我们下午要内部过一下'); assert.match(item.body, /李明：赵经理，报价单能今天发吗？/)
  assert.equal(item.data.messages.length, 2, 'two messages, one item'); assert.equal(item.data.fromSeq, 101); assert.equal(item.data.toSeq, 102)
  assert.equal(await f.poll(), 0, 'the same segment is not produced again')
  // What the preparation agent and triage read for it.
  const task = { id: 't', title: item.title, from: item.from, subject: item.subject, body: item.body, receivedAt: item.receivedAt, source: { folder: item.scope, uid: item.position }, channelData: item.data }
  assert.deepEqual(f.channel.ai.agentInput(task), { conversation: { channel: 'wechat', chat: '李明', group: false, transcript: item.body, lastAt: item.receivedAt } })
  assert.match(f.channel.ai.triageHint('zh'), /channel=wechat/)
  assert.equal(f.channel.ai.exampleLabel(task), '微信 李明')
})

test('a segment waits for the conversation to go quiet', async t => {
  const f = fixture(t)
  f.configure(settings({ quietMinutes: 3 }))
  await f.poll()
  f.fake.say('wxid_li', '在吗', { at: new Date().toISOString() })
  assert.equal(await f.poll(), 0)
  assert.equal(f.state.entries.wxid_li.messages.length, 1)
  f.state.entries.wxid_li.lastAt = minutesAgo(4); f.state.entries.wxid_li.firstAt = minutesAgo(4)
  assert.equal(await f.poll(), 1)
  assert.deepEqual(f.state.entries, {})
})

test('groups: only segments that mention you, unless the group scope is all; answered segments are dropped', async t => {
  const f = fixture(t)
  f.configure(settings({ groups: { mode: 'allow', list: ['111@chatroom'], scope: 'mention' } }))
  await f.poll()
  f.fake.say('111@chatroom', '今天华东线的车都排满了', { sender: 'wxid_qian', senderName: '钱多多' })
  assert.equal(await f.poll(), 0, 'chatter without a mention is dropped')
  f.fake.say('111@chatroom', '车约好了', { sender: 'wxid_qian', senderName: '钱多多' })
  f.fake.say('111@chatroom', '@赵晓强 200 台能加急吗', { sender: 'wxid_wang', senderName: '王工', mentionsMe: true })
  assert.equal(await f.poll(), 1)
  const [item] = f.items
  assert.equal(item.data.group, true); assert.equal(item.data.mentioned, true); assert.equal(item.subject, '华东交付群')
  assert.match(item.body, /王工（@我）：@赵晓强 200 台能加急吗/); assert.match(item.body, /钱多多：车约好了/, 'context before the mention is kept')
  // Already answered in WeChat: nothing to do.
  f.fake.say('wxid_li', '能今天发吗？'); f.fake.say('wxid_li', '可以，下午发', { self: true })
  f.configure(settings({ groups: { mode: 'allow', list: ['111@chatroom'], scope: 'all' } }))
  await f.poll(); await f.poll()
  assert.equal(f.items.length, 1)
  f.fake.say('111@chatroom', '周五前能到吗', { sender: 'wxid_qian', senderName: '钱多多' })
  assert.equal(await f.poll(), 1, 'scope all handles unmentioned group messages')
})

test('removing a chat from the list forgets its progress; adding it back starts from new messages', async t => {
  const f = fixture(t)
  f.configure(settings({ quietMinutes: 30 }))
  await f.poll()
  f.fake.say('wxid_li', '第一句', { at: new Date().toISOString() })
  await f.poll()
  assert.ok(f.state.entries.wxid_li)
  f.configure(settings({ people: { mode: 'allow', list: [] } }))
  await f.poll()
  assert.deepEqual(f.state, { cursors: {}, entries: {} })
  f.fake.say('wxid_li', '你不在时说的话')
  f.configure(settings())
  await f.poll(); await f.poll()
  assert.equal(f.items.length, 0, 're-added chat does not replay the gap')
})

test('unchanged conversations are not queried between sweeps', async t => {
  const f = fixture(t)
  f.configure(settings({ people: { mode: 'block', list: [] } }))
  f.fake.say('wxid_li', '旧消息'); f.fake.say('wxid_mom', '旧消息')
  await f.poll(); await f.poll()
  f.fake.polled.length = 0
  await f.poll()
  assert.deepEqual(f.fake.polled, [], 'nothing changed, nothing polled')
  await new Promise(resolve => setTimeout(resolve, 4100))
  f.fake.say('wxid_mom', '记得穿外套')
  await f.poll()
  assert.deepEqual(f.fake.polled, [['wxid_mom']], 'only the conversation that moved')
})

test('settings validation, status, page data and clearing the local cache', async t => {
  const f = fixture(t)
  assert.throws(() => f.configure(settings({ people: { mode: 'allow', list: ['111@chatroom'] } })), /人员名单里不能放群聊/)
  assert.throws(() => f.configure(settings({ groups: { mode: 'allow', list: ['wxid_li'], scope: 'mention' } })), /群聊名单里只能放群聊/)
  assert.throws(() => f.configure({ ...settings(), extra: 1 }), /微信设置无效/)
  assert.throws(() => f.configure(settings({ quietMinutes: 0 })), /微信设置无效/)
  await assert.rejects(f.action('wechatChats'), error => error.status === 409 && /开启微信读取/.test(error.message))
  f.configure(settings({ names: { wxid_li: '李明' }, people: { mode: 'allow', list: ['wxid_li', 'wxid_li'] } }))
  assert.equal((await f.action('wechatStatus')).name, '赵晓强')
  assert.equal((await f.action('wechatChats')).length, 4)
  assert.equal((await f.action('wechatSearch', { q: '李' }))[0].id, 'wxid_li')
  await f.poll()
  assert.deepEqual(f.channel.health(), { ready: true, name: '赵晓强', library: 'test', error: undefined })
  const page = f.channel.snapshot(f.channel.settings.validate(settings()), f.state)
  assert.equal(page.watching, 1); assert.equal(page.settings.groups.scope, 'mention'); assert.equal(page.settings.quietMinutes, 3)
  await assert.rejects(f.action('clearWechatCache'), /确认/)
  await f.action('clearWechatCache', { confirmed: true }); assert.equal(f.cleared, 1)
  assert.match(f.logs.at(-1), /已清除微信本地解密缓存/)
})

test('the session list is answered from memory; one bridge query at a time; stale lists refresh in the background', async t => {
  const f = fixture(t)
  f.configure(settings())
  f.fake.chatCalls.length = 0
  // Concurrent first requests share one bridge query.
  let open; f.fake.gate(new Promise(resolve => { open = resolve }))
  const first = Promise.all([f.action('wechatChats'), f.action('wechatChats')])
  await new Promise(resolve => setTimeout(resolve, 20))
  open(); f.fake.gate(undefined)
  const [a, b] = await first
  assert.equal(a.length, 4); assert.deepEqual(a, b)
  assert.equal(f.fake.chatCalls.length, 1, 'one query for both callers')
  // Fresh: answered from memory, the bridge is not asked.
  f.fake.chats[0] = { ...f.fake.chats[0], name: '李明（新）' }
  assert.equal((await f.action('wechatChats'))[0].name, '李明')
  assert.equal(f.fake.chatCalls.length, 1)
  // Older than a minute: the old list comes back at once and a refresh starts behind it.
  const start = Date.now()
  t.mock.method(Date, 'now', () => start + 61000)
  assert.equal((await f.action('wechatChats'))[0].name, '李明', 'stale list returned without waiting')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(f.fake.chatCalls.length, 2)
  Date.now.mock.restore()
  assert.equal((await f.action('wechatChats'))[0].name, '李明（新）', 'refreshed list is used next time')
  // A page that goes away stops waiting without cancelling the shared query.
  f.channel.settings.changed()
  f.fake.gate(new Promise(resolve => { open = resolve }))
  const controller = new AbortController()
  const waiting = f.action('wechatChats', {}, controller.signal)
  const other = f.action('wechatChats')
  await new Promise(resolve => setTimeout(resolve, 20))
  controller.abort(new Error('页面已离开'))
  await assert.rejects(waiting, /页面已离开/)
  open(); f.fake.gate(undefined)
  assert.equal((await other).length, 4)
  // Lists changed while a query was in flight: its answer is not kept as the cache.
  f.channel.settings.changed()
  f.fake.gate(new Promise(resolve => { open = resolve }))
  const before = f.action('wechatChats')
  await new Promise(resolve => setTimeout(resolve, 20))
  f.channel.settings.changed()
  open(); f.fake.gate(undefined)
  await before
  const calls = f.fake.chatCalls.length
  await f.action('wechatChats')
  assert.equal(f.fake.chatCalls.length, calls + 1, 'old answer dropped after the lists changed')
})

// Windows: `py -3` is the usual launcher; elsewhere python3 or python.
const python = [['py', '-3'], ['python3'], ['python']].find(([cmd, ...args]) => spawnSync(cmd, [...args, '--version']).status === 0)
const pythonSetting = python?.join(' ')
test('bridge unit tests (Python)', { skip: !python && 'Python not available' }, () => {
  const result = spawnSync(python[0], [...python.slice(1), '-m', 'unittest', 'wechat/test_bridge.py', 'wechat/test_wxread.py'], { cwd: join(here, '..'), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('end to end through the real bridge process with a fixture database', { skip: !python && 'Python not available' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'weixin-bridge-'))
  const fixtureFile = join(here, 'fixtures', 'wechat.json')
  const bridge = new WechatBridge({ python: pythonSetting, workdir: join(root, 'cache'), args: ['--fixture', fixtureFile] })
  const connector = new WechatConnector(join(root, 'cache2'), ['--fixture', fixtureFile])
  const channel = createWechatChannel({ service: s => connector.service({ ...s, python: pythonSetting }), clear: () => connector.clear(), close: () => connector.close() })
  // Close everything before deleting the folder (Windows keeps open files).
  t.after(async () => { channel.close(); bridge.close(); await rm(root, { recursive: true, force: true }) })
  assert.deepEqual(await bridge.status(), { ready: true, protocol: 1, wxid: 'wxid_me', name: '赵晓强', library: 'fixture' })
  const chats = await bridge.chats()
  assert.deepEqual(chats.map(c => c.id), ['wxid_liming', '111@chatroom', 'wxid_mom', '222@chatroom'], 'official and system accounts are not listed')
  assert.ok(chats.every(c => !('summary' in c)), 'no message previews leave the bridge')
  const polled = await bridge.poll({ '111@chatroom': 0 })
  assert.equal(polled['111@chatroom'][1].mentionsMe, true); assert.equal(polled['111@chatroom'][0].senderName, '钱多多')
  // Through the channel, with the connector starting the same bridge.
  const saved = channel.settings.validate({ enabled: true, people: { mode: 'allow', list: ['wxid_liming'] }, groups: { mode: 'allow', list: [], scope: 'mention' } })
  let state = { cursors: {}, entries: {} }
  const poll = async () => { const result = await channel.poll(saved, state, new AbortController().signal); if (!result) return []; const applied = result.commit(state, Date.now()); state = applied.state; return applied.items }
  await poll()
  assert.equal(state.cursors.wxid_liming, 4000)
  const service = connector.service({ ...saved, python: pythonSetting })
  await service.call('fixture_append', { chat: 'wxid_liming', row: { local_id: 9, sort_seq: 9000, type: '文本', sender_username: 'wxid_liming', create_time: Math.floor(Date.now() / 1000) - 600, content: '报价单今天能发吗？' } })
  const [item] = await poll()
  assert.equal(item.data.chatName, '李明 · 启明演示'); assert.match(item.body, /李明 · 启明演示：报价单今天能发吗？/)
  assert.equal(channel.health().ready, true)
})
