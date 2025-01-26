var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  Config: () => Config,
  apply: () => apply,
  inject: () => inject,
  name: () => name,
  usage: () => usage
});
module.exports = __toCommonJS(src_exports);
var import_koishi = require("koishi");
var name = "brick";
var usage = `更新日志：https://forum.koishi.xyz/t/topic/9593  
烧制砖块，然后拍晕群友！  
如果机器人没有禁言的权限，将改为停止响应被拍晕的用户相同时间！  
开始烧制之后，群内其他群友发送一定数量的消息就能完成烧制！  
烧出来的砖头不能跨群用哦！  `;
var Config = import_koishi.Schema.intersect([
  import_koishi.Schema.object({
    maxBrick: import_koishi.Schema.number().default(1).description("砖块最多持有量"),
    cost: import_koishi.Schema.number().required().description("多少条消息能烧好一块砖"),
    cooldown: import_koishi.Schema.number().default(60).description("拍砖冷却时间（秒）"),
    minMuteTime: import_koishi.Schema.number().default(10).description("最小禁言时间（秒）"),
    maxMuteTime: import_koishi.Schema.number().default(120).description("最大禁言时间（秒）"),
    reverse: import_koishi.Schema.number().default(10).description("反被拍晕的概率（%）")
  }),
  import_koishi.Schema.object({
    checking: import_koishi.Schema.boolean().default(false).description("是否开启每日签到（获取随机数量的砖头）")
  }),
  import_koishi.Schema.union([
    import_koishi.Schema.object({
      checking: import_koishi.Schema.const(true).required(),
      minGain: import_koishi.Schema.number().required().description("最小获取数量"),
      maxGain: import_koishi.Schema.number().required().description("最大获取数量")
    }),
    import_koishi.Schema.object({
      checking: import_koishi.Schema.const(false)
    })
  ])
]);
var inject = ["database"];
async function apply(ctx, config) {
  ctx.model.extend("brick", {
    id: "unsigned",
    userId: "string",
    guildId: "string",
    brick: "unsigned",
    lastSlap: "unsigned",
    checkingDay: "string"
  }, { primary: "id", autoInc: true });
  let users = {};
  ctx.command("砖头");
  ctx.command("砖头.烧砖", "烧点砖头拍人").alias("烧砖").action(async ({ session }) => {
    let user = `${session.guildId}:${session.userId}`;
    if (!users[user]) {
      users[user] = {};
    }
    let userData = await ctx.database.get("brick", {
      userId: session.userId,
      guildId: session.guildId
    });
    if (userData.length === 0) {
      await ctx.database.create("brick", {
        userId: session.userId,
        guildId: session.guildId,
        brick: 0
      });
    } else if (userData[0].brick >= config.maxBrick) {
      return `你最多只能拥有${config.maxBrick}块砖`;
    } else if (users?.[user]?.burning) {
      return `已经在烧砖了`;
    }
    users[user].burning = true;
    await session.send(`现在开始烧砖啦，群友每发送${config.cost}条消息就烧好一块砖`);
    let messageCount = 0;
    let dispose = ctx.guild(session.guildId).middleware(async (session_in, next) => {
      if (![session.userId, session.selfId].includes(session_in.userId)) {
        messageCount += 1;
        if (messageCount >= config.cost) {
          dispose();
          await ctx.database.upsert("brick", (row) => [{
            userId: session.userId,
            guildId: session.guildId,
            brick: import_koishi.$.add(row.brick, 1)
          }], ["userId", "guildId"]);
          users[user].burning = false;
          await session.send(`${import_koishi.h.at(session.userId)} 砖已经烧好啦`);
        }
      }
      return next();
    }, true);
  });
  ctx.command("砖头.拍人 <user:user>", "拍晕（禁言）对方随机时间，有概率被反将一军", { checkArgCount: true }).alias("拍人").example("拍人 @koishi").action(async ({ session }, user) => {
    let targetUserId = user.split(":")[1];
    let brickData = await ctx.database.get("brick", {
      userId: session.userId,
      guildId: session.guildId
    });
    if (!brickData || brickData.length === 0 || brickData[0]?.brick === 0) {
		return "你在这个群还没有砖头，使用 砖头.烧砖 烧点砖头吧";
	}
    let diff = Math.trunc(Date.now() / 1e3 - brickData[0].lastSlap);
    if (diff < config.cooldown) {
      return `${Math.abs(diff - config.cooldown)} 秒后才能再拍人哦`;
    } else if (users[`${session.guildId}:${targetUserId}`]?.muted) {
      return "他已经晕了...";
    }
    await ctx.database.upsert("brick", (row) => [{
      userId: session.userId,
      guildId: session.guildId,
      brick: import_koishi.$.subtract(row.brick, 1),
      lastSlap: Date.now() / 1e3
    }], ["userId", "guildId"]);
    let muteTime = import_koishi.Random.int(config.minMuteTime, config.maxMuteTime);
    let muteTimeMs = muteTime * 1e3;
    if (import_koishi.Random.bool(config.reverse / 100)) {
      if (users[`${session.guildId}:${session.userId}`]) {
        users[`${session.guildId}:${session.userId}`].muted = true;
      } else {
        users[`${session.guildId}:${session.userId}`] = { muted: true };
      }
      await session.bot.muteGuildMember(session.guildId, session.userId, muteTimeMs);
      silent(session.userId, muteTimeMs);
      return `${import_koishi.h.at(targetUserId)} 夺过你的砖头，把你拍晕了 ${muteTime} 秒`;
    } else {
      if (users[`${session.guildId}:${targetUserId}`]) {
        users[`${session.guildId}:${targetUserId}`].muted = true;
      } else {
        users[`${session.guildId}:${targetUserId}`] = { muted: true };
      }
      await session.bot.muteGuildMember(session.guildId, targetUserId, muteTimeMs);
      silent(targetUserId, muteTimeMs);
      return `${import_koishi.h.at(targetUserId)} 你被 ${import_koishi.h.at(session.userId)} 拍晕了 ${muteTime} 秒`;
    }
    function silent(userId, time) {
      let dispose = ctx.guild(session.guildId).middleware((session2, next) => {
        if (session2.userId !== userId) {
          return next();
        }
      }, true);
      ctx.setTimeout(() => {
        dispose();
        users[`${session.guildId}:${userId}`].muted = false;
      }, time);
    }
    __name(silent, "silent");
  });
  ctx.command("砖头.随机拍人", "随机拍晕（禁言）某个群友随机时间，有概率被反将一军").alias("随机拍人").action(async ({ session }) => {
    let guildMember = [];
    for await (let member of session.bot.getGuildMemberIter(session.guildId)) {
      guildMember.push(member?.user.id);
    }
    await session.execute(`砖头.拍人 ${import_koishi.h.at(import_koishi.Random.pick(guildMember))}`);
  });
  ctx.command("砖头.查看", "看看自己在这个群有多少砖头").alias("查看砖头").action(async ({ session }) => {
    let brickData = await ctx.database.get("brick", {
      userId: session.userId,
      guildId: session.guildId
    });
    if (brickData.length === 0 || brickData[0].brick === 0) {
      return `你还没有砖头，使用 砖头.烧砖 烧点吧`;
    } else {
      return `你有 ${brickData[0].brick}/${config.maxBrick} 块砖头`;
    }
  });
  if (config.checking) {
    ctx.command("砖头.签到").alias("砖头签到").action(async ({ session }) => {
      let date = /* @__PURE__ */ new Date();
      let today = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
      let brick = import_koishi.Random.int(config.minGain, config.maxGain + 1);
      let userData = await ctx.database.get("brick", {
        userId: session.userId,
        guildId: session.guildId
      });
      if (userData.length === 0) {
        await ctx.database.create("brick", {
          userId: session.userId,
          guildId: session.guildId,
          brick,
          checkingDay: today
        });
        return `签到成功，你获得了 ${brick} 块砖头，你现在有${brick}/${config.maxBrick}块砖头`;
      } else if (userData[0].brick >= config.maxBrick) {
        return `你的砖头已经到上限了，用掉再签到吧`;
      } else if (userData[0].checkingDay !== today) {
        if (userData[0].brick + brick > config.maxBrick) {
          brick = config.maxBrick - userData[0].brick;
        }
        await ctx.database.upsert("brick", (row) => [{
          userId: session.userId,
          guildId: session.guildId,
          brick: import_koishi.$.add(row.brick, brick),
          checkingDay: today
        }], ["userId", "guildId"]);
        return `签到成功，获得了 ${brick} 块砖头，现在你有 ${userData[0].brick + brick}/${config.maxBrick} 块砖头`;
      } else {
        return "你今天已经签到过了";
      }
    });
  }
}
__name(apply, "apply");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Config,
  apply,
  inject,
  name,
  usage
});
