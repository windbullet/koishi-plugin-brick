import { Context, Schema, Random, h, $, Logger } from 'koishi'

export const name = 'brick'

export const usage = `更新日志：https://forum.koishi.xyz/t/topic/9593
烧制砖块，然后拍晕群友！
如果机器人没有禁言的权限，将改为停止响应被拍晕的用户相同时间！
开始烧制之后，群内其他群友发送一定数量的消息就能完成烧制！
烧出来的砖头不能跨群用哦！`

// 更新数据库表结构，增加持久化状态字段
export interface Brick {
  id: number
  userId: string
  guildId: string
  brick: number
  lastSlap: number
  checkingDay: string
  isBurning: boolean
  burningProgress: number
  slapEndTimestamp: number
}

declare module 'koishi' {
  interface Tables {
    brick: Brick
  }
}

interface SpecialUser {
  [userId: string]: number
}

// 在配置接口中添加 allowCrossGuildBricks 选项
export interface Config {
  maxBrick: number
  cost: number
  cooldown: number
  minMuteTime: number
  maxMuteTime: number
  reverse: number
  specialUser: SpecialUser
  checking: boolean
  allowSlapAll: boolean
  allowCrossGuildBricks: boolean
  minGain?: number
  maxGain?: number
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    maxBrick: Schema.number()
      .default(1)
      .description('砖块最多持有量'),
    cost: Schema.number()
      .required()
      .description('多少条消息能烧好一块砖'),
    cooldown: Schema.number()
      .default(60)
      .description('拍砖冷却时间（秒）'),
    minMuteTime: Schema.number()
      .default(10)
      .description('最小禁言时间（秒）'),
    maxMuteTime: Schema.number()
      .default(120)
      .description('最大禁言时间（秒）'),
    reverse: Schema.number()
      .default(10)
      .max(100)
      .description('反被拍晕的默认概率（%）'),
    specialUser: Schema.dict(Number)
      .role('table')
      .description('键为用户ID，值为被拍时的反击概率（%）<br/>不设置则使用默认概率'),
    allowSlapAll: Schema.boolean()
      .default(true)
      .description('（管理员能力）是否允许拍全体成员'),
    // 添加跨群使用砖头的配置项
    allowCrossGuildBricks: Schema.boolean()
      .default(false)
      .description('是否允许用户跨群使用砖头（若数据库已有单群数据，则禁用该配置）')
  }),
  Schema.object({
    checking: Schema.boolean()
      .default(false)
      .description('是否开启每日签到（获取随机数量的砖头）'),
  }),
  Schema.union([
    Schema.object({
      checking: Schema.const(true).required(),
      minGain: Schema.number().required().description('最小获取数量'),
      maxGain: Schema.number().required().description('最大获取数量'),
    }),
    Schema.object({
      checking: Schema.const(false)
    })
  ])
])

export const inject = ["database"]
const logger = new Logger('brick')

export async function apply(ctx: Context, config: Config) {
  // 数据库表初始化，增加新字段
  ctx.model.extend('brick', {
    id: 'unsigned',
    userId: 'string',
    guildId: 'string',
    brick: 'integer',
    lastSlap: 'unsigned',
    checkingDay: 'string',
    isBurning: boolean
    burningProgress: 'integer',
    slapEndTimestamp: 'unsigned'
  }, { primary: 'id', autoInc: true })

  // 在 ready 生命周期中检查跨群功能是否可用
  ctx.on('ready', async () => {
    if (config.allowCrossGuildBricks) {
      try {
        // 检查数据库中是否存在任何带有 guildId 的数据
        const hasGuildData = await ctx.database.get('brick', {
          guildId: { $ne: '' }
        })
        if (hasGuildData.length > 0) {
          config.allowCrossGuildBricks = false
          logger.warn('数据库中已存在单群数据，为防止冲突，跨群使用砖头功能已自动禁用。')
        }
      } catch (e) {
        logger.error('检查数据库时出错：', e)
        config.allowCrossGuildBricks = false
      }
    }
  })

  // 辅助函数，用于获取数据库查询条件
  function getQuery(session) {
    const query = { userId: session.userId }
    if (!config.allowCrossGuildBricks) {
      query['guildId'] = session.guildId
    }
    return query
  }

  // 辅助函数，用于获取 upsert 的 primary keys
  function getPrimaryKeys() {
    return config.allowCrossGuildBricks ? ["userId"] : ["userId", "guildId"]
  }

  // 辅助函数，移到顶层以提高性能
  async function slap(session, slapedUserId: string, time: number) {
    try {
      await session.bot.muteGuildMember(session.guildId, slapedUserId, time * 1000)
    } catch {
      // 无权限时 fallback 到静默
      silent(session, slapedUserId, time)
    }
  }

  // 辅助函数，实现非禁言权限时的静默
  function silent(session, slapedUserId: string, time: number) {
    const slapEndTimestamp = Math.trunc(Date.now() / 1000) + time
    const data = {
      userId: slapedUserId,
      slapEndTimestamp: slapEndTimestamp
    }
    if (!config.allowCrossGuildBricks) {
      data['guildId'] = session.guildId
    }
    ctx.database.upsert('brick', (row) => [data], getPrimaryKeys())
  }

  // 在每个消息处理前检查用户是否被静默
  ctx.guild().middleware(async (session, next) => {
    const userData = await ctx.database.get('brick', getQuery(session))

    if (userData.length > 0 && userData[0].slapEndTimestamp > Math.trunc(Date.now() / 1000)) {
      return // 如果被静默，直接停止响应
    }

    return next()
  })

  ctx.command("砖头")

  ctx.command("砖头.烧砖", "烧点砖头拍人")
    .alias("烧砖")
    .action(async ({ session }) => {
      const query = getQuery(session)
      // 使用 upsert 简化逻辑，确保用户数据存在
      const userData = await ctx.database.upsert('brick', (row) => [{
        ...query,
        brick: row.brick || 0,
        isBurning: row.isBurning || false,
        burningProgress: row.burningProgress || 0,
        lastSlap: row.lastSlap || 0,
        checkingDay: row.checkingDay || '',
        slapEndTimestamp: row.slapEndTimestamp || 0
      }], getPrimaryKeys())

      if (userData[0].isBurning) {
        return `你已经在烧砖了，进度为 ${userData[0].burningProgress}/${config.cost} 条消息`
      }

      if (userData[0].brick >= config.maxBrick) {
        return `你最多只能拥有${config.maxBrick}块砖`
      }

      // 更新数据库状态为正在烧砖
      await ctx.database.upsert('brick', (row) => [{
        ...query,
        isBurning: true,
        burningProgress: 0
      }], getPrimaryKeys())

      await session.send(`现在开始烧砖啦，群友每发送${config.cost}条消息就烧好一块砖`)

      // 使用 middleware 监听其他群友消息
      const dispose = ctx.guild(session.guildId).middleware(async (session_in, next) => {
        // 只有非烧砖者和非机器人本人的消息才算数
        if (![session.selfId, session.userId].includes(session_in.userId)) {
          const query_in = getQuery(session)
          // 再次查询确保状态是最新的
          const currentData = await ctx.database.get('brick', query_in)

          if (currentData.length > 0 && currentData[0].isBurning) {
            const newProgress = currentData[0].burningProgress + 1
            // 更新烧砖进度
            await ctx.database.upsert('brick', (row) => [{
              ...query_in,
              burningProgress: $.add(row.burningProgress, 1)
            }], getPrimaryKeys())

            if (newProgress >= config.cost) {
              dispose()
              // 完成烧砖，更新数据库状态和砖头数量
              await ctx.database.upsert('brick', (row) => [{
                ...query_in,
                brick: $.add(row.brick, 1),
                isBurning: false
              }], getPrimaryKeys())
              await session.send(`${h.at(session.userId)} 砖已经烧好啦`)
            }
          }
        }
        return next()
      }, true)
    })

  ctx.command("砖头.拍人 <user:user>", "拍晕（禁言）对方随机时间，有概率被反将一军", { checkArgCount: true })
    .alias("拍人")
    .example("拍人 @koishi")
    .action(async ({ session }, user) => {
      const query = getQuery(session)
      // 检查拍人者是否有砖头，此检查已提前至所有逻辑之前
      const brickData = await ctx.database.get('brick', query)

      if (brickData.length === 0 || brickData[0].brick <= 0) {
        return "你在这个群还没有砖头，使用 砖头.烧砖 烧点砖头吧"
      }

      // 处理拍机器人
      if (user === session.bot.userId || user.split(':')[1] === session.bot.userId) {
        return "为什么拍我！"
      }

      // 处理拍全体成员，并检查配置
      if (user === "all" || user === "@all") {
        if (!config.allowSlapAll) {
          return "管理员已禁用拍全体成员功能"
        }

        const members = await session.bot.getGuildMemberIter(session.guildId).toArray()
        const memberCount = members.length - 1 // 排除机器人自己

        if (brickData[0].brick < memberCount) {
          return `拍全体成员需要 ${memberCount} 块砖头，但你只有 ${brickData[0].brick} 块`
        }

        const muteTime = Random.int(config.minMuteTime, config.maxMuteTime)
        const probability = config.reverse / 100

        // 消耗砖头
        await ctx.database.upsert('brick', (row) => [{
          ...query,
          brick: $.subtract(row.brick, memberCount),
          lastSlap: Math.trunc(Date.now() / 1000)
        }], getPrimaryKeys())

        if (Random.bool(probability)) {
          await slap(session, session.userId, muteTime)
          return `${h.at(session.userId)} 想拍全体成员，结果被自己反拍晕了 ${muteTime} 秒`
        } else {
          for (const member of members) {
            const mId = member?.user?.id
            if (mId && mId !== session.selfId) {
              await slap(session, mId, muteTime)
            }
          }
          return `全体成员被 ${h.at(session.userId)} 用砖头集体拍晕了 ${muteTime} 秒`
        }
      }

      // 普通拍人逻辑
      const targetUserId = user.split(":")[1]
      const query_target = { userId: targetUserId }
      if (!config.allowCrossGuildBricks) {
        query_target['guildId'] = session.guildId
      }
      
      const diff = Math.trunc(Date.now() / 1000 - brickData[0].lastSlap)
      if (diff < config.cooldown) {
        return `${Math.abs(diff - config.cooldown)} 秒后才能再拍人哦`
      }

      const targetUserData = await ctx.database.get('brick', query_target)

      if (targetUserData.length > 0 && targetUserData[0].slapEndTimestamp > Math.trunc(Date.now() / 1000)) {
        return "他已经晕了..."
      }

      // 消耗一块砖头
      await ctx.database.upsert('brick', (row) => [{
        ...query,
        brick: $.subtract(row.brick, 1),
        lastSlap: Math.trunc(Date.now() / 1000)
      }], getPrimaryKeys())

      const muteTime = Random.int(config.minMuteTime, config.maxMuteTime)
      const probability = config.specialUser[targetUserId] !== undefined
        ? config.specialUser[targetUserId] / 100
        : config.reverse / 100

      if (Random.bool(probability)) {
        await slap(session, session.userId, muteTime)
        return `${h.at(targetUserId)} 夺过你的砖头，把你拍晕了 ${muteTime} 秒`
      } else {
        await slap(session, targetUserId, muteTime)
        return `${h.at(targetUserId)} 你被 ${h.at(session.userId)} 拍晕了 ${muteTime} 秒`
      }
    })

  ctx.command("砖头.随机拍人", "随机拍晕（禁言）某个群友随机时间，有概率被反将一军")
    .alias("随机拍人")
    .action(async ({ session }) => {
      const guildMembers = await session.bot.getGuildMemberIter(session.guildId).toArray()
      const targetMember = Random.pick(guildMembers.filter(m => m.user.id !== session.selfId))
      if (!targetMember) return '群内没有其他成员可以拍了'
      
      await session.execute(`砖头.拍人 ${h.at(targetMember.user.id)}`)
    })

  ctx.command("砖头.查看", "看看自己在这个群有多少砖头")
    .alias("查看砖头")
    .action(async ({ session }) => {
      const query = getQuery(session)
      const brickData = await ctx.database.get('brick', query)
      if (brickData.length === 0 || brickData[0].brick === 0) {
        return `你还没有砖头，使用 砖头.烧砖 烧点吧`
      } else {
        return `你有 ${brickData[0].brick}/${config.maxBrick} 块砖头`
      }
    })

  if (config.checking) {
    ctx.command("砖头.签到")
      .alias("砖头签到")
      .action(async ({ session }) => {
        const query = getQuery(session)
        const date = new Date()
        const today = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
        let brick = Random.int(config.minGain, config.maxGain + 1)

        const userData = await ctx.database.get('brick', query)

        if (userData.length === 0) {
          // 如果没有数据，创建新数据
          await ctx.database.create('brick', {
            ...query,
            brick: brick,
            checkingDay: today,
            isBurning: false,
            burningProgress: 0,
            slapEndTimestamp: 0
          })
          return `签到成功，你获得了 ${brick} 块砖头，现在有${brick}/${config.maxBrick}块砖头`
        }

        if (userData[0].checkingDay === today) {
          return "你今天已经签到过了"
        }

        if (userData[0].brick >= config.maxBrick) {
          return `你的砖头已经到上限了，用掉再签到吧`
        }

        if (userData[0].brick + brick > config.maxBrick) {
          brick = config.maxBrick - userData[0].brick
        } else if (userData[0].brick + brick < 0) {
          brick = -userData[0].brick
        }

        await ctx.database.upsert('brick', (row) => [{
          ...query,
          brick: $.add(row.brick, brick),
          checkingDay: today
        }], getPrimaryKeys())

        const updatedData = await ctx.database.get('brick', query)

        return `签到成功，你获得了 ${brick} 块砖头，现在有 ${updatedData[0].brick}/${config.maxBrick} 块砖头`
      })
  }
}
