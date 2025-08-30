import { type Context, Schema, h } from 'koishi'
import { createHash } from 'node:crypto'
import { randomInt } from 'node:crypto'

export const name = 'jrrp'

export const Config: Schema<any> = Schema.object({})
export const inject = ['database']

interface JrrpSentence {
  id: number
  sender: string
  sentence: string
  fingerprint: string
  source: string
  createdAt: number
}

const table = 'jrrp_las'

declare module 'koishi' {
  interface Tables {
    [table]: JrrpSentence
  }
}

function luckSimple(num: number): [string, string] {
  if (num < 16) return ['大吉', '万事如意，一帆风顺 ~']
  if (num < 33) return ['吉', '今天是幸运的一天！']
  if (num < 50) return ['末吉', '每日小幸运(1/1)']
  if (num < 66) return ['末凶', '好像有点小问题？']
  if (num < 83) return ['凶', '嘶……问题不大(?)']
  return ['大凶', '开溜(逃)']
}

function hashToUint32(input: string) {
  const buf = createHash('sha256').update(input).digest()
  return buf.readUInt32BE(0)
}

function trimBr(str: string) {
  return str.replace(/^[\n\r]+|[\n\r]+$/g, '')
}

function normalizeSentence(str: string) {
  return trimBr(str.replace(/\r\n/g, '\n'))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function todayYYMMDD() {
  const date = new Date()
  return `${date.getFullYear().toString().slice(2)}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}`
}

export function apply(ctx: Context) {
  ctx.model.extend(
    table,
    {
      id: 'unsigned',
      sender: 'string',
      sentence: 'text',
      fingerprint: 'string',
      source: 'string',
      createdAt: 'unsigned'
    },
    { primary: 'id', autoInc: true }
  )

  const base = ctx.command('jrrp').alias('今日人品')

  base.action(async ({ session }) => {
    const ymd = todayYYMMDD()
    const seed = `${session.platform}:${session.userId}:${ymd}:luck`
    const lucknum = (hashToUint32(seed) % 100) + 1
    const [title, tip] = luckSimple(lucknum)

    const all = await ctx.database.get(table, {})
    let sender = '?'
    let quote = '快点使用 今日人品 投稿！！！'

    if (all.length > 0) {
      const index = randomInt(0, all.length)
      const picked = all[index]
      sender = picked.sender || '?'
      quote = `「${picked.sentence}」\n    ——${picked.source}`
    }

    const reply = [
      h.quote(session.messageId),
      `=====『${title}』=====`,
      `* 幸运指数 : ${100 - lucknum}%`,
      `${tip}`,
      '- - - - - - - - - - - - - - - -',
      `${quote}`,
      `---[ from ${sender} ]---`,
      '今日人品 帮助'
    ].join('\n')

    await session.send(reply)
  })

  base.subcommand('投稿', '投稿语录').action(async ({ session }) => {
    const content = (session.content || '').replace(/\r\n/g, '\n')
    if (!(content.includes('!文本\n') && content.includes('!出处\n'))) {
      await session.send(
        '投稿格式: \n今日人品 投稿\n!文本\n在此处填写文本 可换行\n!出处\n在此处填写出处 作者《出处》'
      )
      return
    }

    try {
      const sentence = trimBr(
        content.split('\n!出处\n')[0].split('!文本\n')[1] || ''
      )
      const source = trimBr(content.split('!出处\n')[1] || '')
      const fingerprint = normalizeSentence(sentence)

      const dup = await ctx.database.get(table, { fingerprint }, { limit: 1 })
      if (dup.length) {
        await session.send('投稿失败: 已存在相同的语句喵~')
        return
      }

      await ctx.database.create(table, {
        sender: session.userId,
        sentence,
        fingerprint,
        source,
        createdAt: Date.now()
      })

      await session.send(`投稿成功:\n「${sentence}」\n    ——${source}`)
    } catch (_e) {
      await session.send('投稿失败')
    }
  })

  base
    .subcommand('撤回投稿', '撤回自己的上一条投稿')
    .action(async ({ session }) => {
      const records = await ctx.database.get(
        table,
        { sender: session.userId },
        { limit: 1, sort: { createdAt: 'desc' } }
      )
      const last = records[0]
      if (!last) {
        await session.send('撤回失败:找不到可以撤回的消息')
        return
      }
      await ctx.database.remove(table, { id: last.id })
      await session.send(
        `撤回成功:\n「${last.sentence}」\n    ——${last.source}`
      )
    })

  base
    .subcommand('帮助', '显示此插件的帮助信息')
    .action(async ({ session }) => {
      await session.send(
        '今日人品\n今日人品 -> 今日幸运指数+语录(娱乐向)\n——语录每人每日至多随机三句(但是有新投稿就会刷新 特性!)\n今日人品 投稿 -> 查看如何投稿语录\n今日人品 撤回投稿 -> 撤回自己的上一条投稿\n今日人品 帮助 -> 显示此信息'
      )
    })
}
