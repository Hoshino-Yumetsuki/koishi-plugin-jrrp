import { type Context, Schema, h } from 'koishi'
import { createHash, randomInt } from 'node:crypto'

export const name = 'jrrp'

export const inject = ['database', 'http']

export interface Config {
  useHitokoto: boolean
}

export const Config: Schema<Config> = Schema.object({
  useHitokoto: Schema.boolean()
    .default(true)
    .description(
      '是否使用一言（hitokoto.cn），开启后会在投稿与一言中随机展示其一'
    )
})

interface JrrpSentence {
  id: number
  sender: string
  sentence: string
  fingerprint: string
  source: string
  createdAt: number
}

const table = 'jrrp_las'

interface HitokotoResp {
  id: number
  uuid: string
  hitokoto: string
  type: string
  from: string
  from_who?: string | null
}

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

function shuffleArray<T>(arr: T[]) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1)
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
}

function todayYYMMDD() {
  const date = new Date()
  return `${date.getFullYear().toString().slice(2)}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}`
}

export function apply(ctx: Context, config: Config) {
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

    type Candidate = { kind: 'db'; index: number } | { kind: 'hitokoto' }
    const candidates: Candidate[] = all.map((_, i) => ({
      kind: 'db',
      index: i
    }))
    if (config.useHitokoto) candidates.push({ kind: 'hitokoto' })
    shuffleArray(candidates)

    const tryPickHitokoto = async () => {
      try {
        const data = (await ctx.http.get('https://v1.hitokoto.cn', {
          params: { encode: 'json' },
          timeout: 5000
        })) as unknown as HitokotoResp

        const author = (data.from_who || '').trim()
        const from = (data.from || '').trim()
        const source =
          author && from
            ? `${author}《${from}》`
            : from
              ? `《${from}》`
              : author || '一言'

        quote = `「${data.hitokoto}」\n    ——${source}`
        sender = 'hitokoto.cn'
        return true
      } catch {
        return false
      }
    }

    let _picked = false
    for (const c of candidates) {
      if (c.kind === 'db') {
        const pickedDb = all[c.index]
        if (pickedDb) {
          sender = pickedDb.sender || '?'
          quote = `「${pickedDb.sentence}」\n    ——${pickedDb.source}`
          _picked = true
          break
        }
      } else if (await tryPickHitokoto()) {
        _picked = true
        break
      }
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

  ctx.command('jrrp.投稿').action(async ({ session }) => {
    const raw = session.content || ''
    const content = raw.replace(/\r\n/g, '\n')

    const m = content.match(/!文本\s*([\s\S]*?)\s*!出处\s*([\s\S]+)$/)
    if (!m) {
      await session.send(
        '投稿格式: \n今日人品 投稿\n!文本\n在此处填写文本 可换行\n!出处\n在此处填写出处 作者《出处》'
      )
      return
    }

    try {
      const sentence = trimBr(m[1] || '')
      const source = trimBr(m[2] || '')
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

  ctx.command('jrrp.撤回投稿').action(async ({ session }) => {
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
    await session.send(`撤回成功:\n「${last.sentence}」\n    ——${last.source}`)
  })

  ctx.command('jrrp.帮助').action(async ({ session }) => {
    await session.send(
      '今日人品\n今日人品 -> 今日幸运指数+语录(娱乐向)\n——可在配置中启用「一言」：将与投稿语录二选一随机展示\n今日人品 投稿 -> 查看如何投稿语录\n今日人品 撤回投稿 -> 撤回自己的上一条投稿\n今日人品 帮助 -> 显示此信息'
    )
  })
}
